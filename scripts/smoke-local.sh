#!/usr/bin/env bash
#
# scripts/smoke-local.sh
#
# End-to-end smoke test with zero external dependencies:
#   - in-memory Redis (EMULATE_VERCEL_LOCAL=1)
#   - a mock OpenAI-compatible upstream served from a tiny local Node server
#
# It starts `next dev` on a free port and walks the real request path:
#   bootstrap admin -> login -> create customer key -> proxied completion
#   -> usage recorded -> negative cases (bad password / unknown key / unmapped model)
#
# Usage:
#   pnpm smoke            # dev server (default)
#   bash scripts/smoke-local.sh
#
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR" || exit 1

PORT="${SMOKE_PORT:-3211}"
UPSTREAM_PORT="${SMOKE_UPSTREAM_PORT:-8891}"
BASE="http://127.0.0.1:${PORT}"
COOKIE_JAR="$(mktemp)"
TMP_DIR="$(mktemp -d)"
# Node picks the module system from the file extension: the mock must be .mjs.
UPSTREAM_SCRIPT="${TMP_DIR}/upstream.mjs"
UPSTREAM_LOG="${TMP_DIR}/upstream.log"
NEXT_LOG="$(mktemp)"

export RELAY_AUTH="smoke-local-relay-auth-0123456789abcdef"
export UPSTASH_REDIS_REST_URL="http://localhost:13700"
export UPSTASH_REDIS_REST_TOKEN="smoke-token"
export EMULATE_VERCEL_LOCAL="1"
export OPENAI_KEYS="sk-mock-upstream-key"
export OPENAI_BASE_URL="http://127.0.0.1:${UPSTREAM_PORT}/v1"
unset NODE_ENV

cat > "$UPSTREAM_SCRIPT" <<'EOF'
import { createServer } from "node:http";
const port = Number(process.env.SMOKE_UPSTREAM_PORT);
const seen = [];
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.url === "/__seen") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(seen));
    }
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
    seen.push({ auth: req.headers.authorization, model: body.model });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "unknown",
      choices: [{ index: 0, message: { role: "assistant", content: "hello from mock upstream" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock upstream on ${port}`));
EOF

SMOKE_UPSTREAM_PORT="$UPSTREAM_PORT" node "$UPSTREAM_SCRIPT" > "$UPSTREAM_LOG" 2>&1 &
MOCK_PID=$!

./node_modules/.bin/next dev -p "$PORT" > "$NEXT_LOG" 2>&1 &
NEXT_PID=$!

cleanup() {
  kill "$NEXT_PID" "$MOCK_PID" 2>/dev/null
  rm -rf "$COOKIE_JAR" "$TMP_DIR" "$NEXT_LOG"
}
trap cleanup EXIT

fail=0
check() { # check <label> <actual> <expected-substring>
  if printf '%s' "$2" | grep -q "$3"; then
    echo "  ok   $1"
  else
    echo "  FAIL $1"
    echo "       expected to contain: $3"
    echo "       got: $(printf '%s' "$2" | head -c 200)"
    fail=1
  fi
}

for _ in $(seq 1 90); do
  curl -s -o /dev/null --max-time 2 "${BASE}/healthz" && break
  sleep 1
done

echo "RelayAB smoke test → ${BASE}"

HEALTH=$(curl -s "${BASE}/healthz")
check "GET /healthz" "$HEALTH" '"status":"ok"'

LOGIN=$(curl -s -c "$COOKIE_JAR" -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"${RELAY_AUTH}\"}")
check "bootstrap admin can log in" "$LOGIN" '"role":"admin"'

BAD=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/api/auth/login" \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"wrong"}')
check "wrong password rejected (401)" "$BAD" '^401$'

ME=$(curl -s -b "$COOKIE_JAR" "${BASE}/api/auth/me")
check "session works across routes" "$ME" '"username":"admin"'

ANON=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/api/admin/users")
check "admin API requires session (403)" "$ANON" '^403$'

USER_ID=$(curl -s -b "$COOKIE_JAR" "${BASE}/api/admin/users" \
  | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

KEY_RESP=$(curl -s -b "$COOKIE_JAR" -X POST "${BASE}/api/admin/keys" \
  -H 'Content-Type: application/json' \
  -d "{\"userId\":\"${USER_ID}\",\"label\":\"smoke\",\"quotaType\":\"credits\",\"quotaLimit\":500000}")
PLAIN_KEY=$(printf '%s' "$KEY_RESP" | sed -n 's/.*"plainKey":"\([^"]*\)".*/\1/p')
check "customer key issued" "$PLAIN_KEY" '^sk-relay-'

COMPLETION=$(curl -s -X POST "${BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${PLAIN_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}')
check "POST /v1/chat/completions proxied" "$COMPLETION" '"chatcmpl-mock"'

UPSTREAM=$(curl -s "http://127.0.0.1:${UPSTREAM_PORT}/__seen")
check "upstream got decrypted provider key" "$UPSTREAM" 'Bearer sk-mock-upstream-key'
check "model mapping applied upstream" "$UPSTREAM" 'gpt-4o-mini-2024-07-18'

USAGE=$(curl -s -b "$COOKIE_JAR" "${BASE}/api/admin/usage")
check "usage recorded" "$USAGE" '"requests":1'
check "usage tracked in 0.001 积分 units" "$USAGE" '"creditsUsed":1'

QUOTA=$(curl -s -b "$COOKIE_JAR" "${BASE}/api/admin/keys?userId=${USER_ID}")
check "quota consumed in 0.001 积分 units" "$QUOTA" '"quotaUsed":1'

UNKNOWN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE}/v1/chat/completions" \
  -H 'Authorization: Bearer sk-relay-nope' -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[]}')
check "unknown key rejected (401)" "$UNKNOWN" '^401$'

UNMAPPED=$(curl -s -X POST "${BASE}/v1/chat/completions" \
  -H "Authorization: Bearer ${PLAIN_KEY}" -H 'Content-Type: application/json' \
  -d '{"model":"not-a-real-model","messages":[]}')
check "unmapped model rejected" "$UNMAPPED" 'model_not_mapped'

if [ "$fail" -ne 0 ]; then
  echo
  echo "--- server log ---"
  tail -40 "$NEXT_LOG"
  echo "--- upstream log ---"
  tail -20 "$UPSTREAM_LOG"
  exit 1
fi

echo "All smoke checks passed."
