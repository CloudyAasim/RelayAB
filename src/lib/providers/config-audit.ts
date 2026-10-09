/**
 * The configuration mistakes that actually happened, so the checks below are
 * grounded rather than invented:
 *
 *  - five models sat at `inputCost: 0, outputCost: 0` while enabled, billing
 *    nothing at all, and nothing in the system said so;
 *  - one model's rates were `2.1 / 8.4` — yuan per million — sitting in the
 *    same table as `210 / 840`, which is the same number in credits. A hundred
 *    times off, and it looked like a plausible rate;
 *  - several models had `cachedInputCost` set and `cacheWriteCost` absent, so a
 *    write fell back to the input price rather than to the free rate the vendor
 *    actually charges.
 *
 * None of these is a schema error. Every one parses. The value was accepted,
 * stored, and billed, and the only thing that would have caught them is a
 * question asked before the write.
 */

export type Finding = {
  /** Stable-ish key, so a caller can tell the same finding from another. */
  code: "all_zero" | "unit_mismatch" | "cache_write_unset" | "write_gt_input";
  clientId: string;
  message: string;
  /** True when writing this would probably be a mistake. */
  blocking: boolean;
  /**
   * The configuration keys this verdict rests on.
   *
   * The scope a check needs in order to be about *this* write. A price that was
   * already zero before the proposal is a fact about the provider, not about the
   * proposal — and blocking on it makes a free model permanently un-editable,
   * because every proposal about that model merges the same zero back in and
   * trips the same check. There is no field the model can change to get past
   * it: the one useful response was to stop writing prices at all, and the audit
   * reads the merged state, so that changed nothing.
   */
  fields: readonly string[];
};

/**
 * What a caller confirmed, as `code:clientId`.
 *
 * The check has to ask a question somewhere, and "are you sure?" with no way to
 * answer is the same as a refusal: the tool used to end a blocked proposal with
 * "确认无误就再说一次", which is advice that produces the identical failure. This
 * is the answer, and it is per-model on purpose — declaring one model free is
 * not a declaration about the next one.
 */
export const findingKey = (code: Finding["code"], clientId: string): string => `${code}:${clientId}`;

/** A rate is in yuan rather than credits if it is small and another is not. */
const CREDITS_FLOOR = 20; // 0.2 元/百万 token

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

type Row = Record<string, unknown>;

/**
 * What is wrong with one set of model configurations.
 *
 * Takes the state **after** the proposed write, not before, so it judges the
 * outcome rather than the intention.
 *
 * `patches` says what the write actually changes, per model, and that is what
 * decides whether a blocking finding is about *this* proposal. Given one, a
 * blocking finding on fields the patch never touched is downgraded to a
 * reminder: the provider is already in that state, this proposal did not put it
 * there, and refusing the write does not make the state any safer — it only
 * makes the model un-editable. Given nothing (the read-only health check), the
 * finding keeps its own severity, because there it is being asked "is this
 * configuration suspicious", not "should this write be allowed".
 */
export function auditModelConfigs(
  configs: Record<string, Row>,
  opts: { patches?: Record<string, Row> } = {},
): Finding[] {
  const out: Finding[] = [];
  const rows = Object.entries(configs);
  const rates = rows
    .map(([id, c]) => [id, c.inputCost, c.outputCost] as const)
    .filter(([, i, o]) => isNumber(i) || isNumber(o));

  // Anything already in credits, used to judge the ones that are not.
  const inCredits = rates.filter(([, i]) => isNumber(i) && (i as number) >= CREDITS_FLOOR);

  for (const [clientId, cfg] of rows) {
    const input = cfg.inputCost;
    const output = cfg.outputCost;

    if (
      cfg.enabled !== false &&
      isNumber(input) &&
      isNumber(output) &&
      input === 0 &&
      output === 0
    ) {
      out.push({
        code: "all_zero",
        clientId,
        message:
          `输入和输出都是 0，这个模型会完全不计费。` +
          `如果它确实免费请确认；否则这是价格没填。`,
        blocking: true,
        fields: ["inputCost", "outputCost", "enabled"],
      });
    }

    // 2.1 next to 210 is yuan next to credits, not a cheap model.
    if (
      inCredits.length > 0 &&
      isNumber(input) &&
      input > 0 &&
      input < CREDITS_FLOOR
    ) {
      out.push({
        code: "unit_mismatch",
        clientId,
        message:
          `输入价 ${input} 与同一服务商里其它模型的 ${inCredits[0][1]} 量级差约 100 倍——` +
          `1 元 = 100 积分，本系统的价格单位是「每 100 万 token 的积分」。` +
          `确认这是积分不是元。`,
        blocking: true,
        fields: ["inputCost", "outputCost"],
      });
    }

    // A cache read price with no write price silently bills writes at the input
    // rate. Free and unset are different, and only one of them is a discount.
    if (
      isNumber(cfg.cachedInputCost) &&
      cfg.cachedInputCost < (isNumber(input) ? (input as number) : 0) &&
      cfg.cacheWriteCost === undefined
    ) {
      out.push({
        code: "cache_write_unset",
        clientId,
        message:
          `缓存读取价 ${cfg.cachedInputCost} 但缓存写入价没填——写入会回落到按输入价 ` +
          `${input} 计费。如果这个模型的缓存写入是免费的，请显式填 0：留空和 0 不是一回事。`,
        blocking: false,
        fields: ["cachedInputCost", "cacheWriteCost"],
      });
    }

    if (
      isNumber(cfg.cacheWriteCost) &&
      isNumber(input) &&
      (cfg.cacheWriteCost as number) > (input as number) * 3 &&
      (cfg.cacheWriteCost as number) > 0
    ) {
      out.push({
        code: "write_gt_input",
        clientId,
        message: `缓存写入价 ${cfg.cacheWriteCost} 是输入价 ${input} 的三倍以上，请确认没有串行。`,
        blocking: false,
        fields: ["cacheWriteCost", "inputCost"],
      });
    }
  }

  const patches = opts.patches;
  if (!patches) return out;
  return out.map((f) =>
    f.blocking
      ? { ...f, blocking: f.fields.some((field) => field in (patches[f.clientId] ?? {})) }
      : f,
  );
}

/** The one-line form, for a tool result or a proposal's warnings. */
export function describeFindings(findings: Finding[]): string[] {
  return findings.map((f) => `[${f.code}] ${f.clientId}：${f.message}`);
}

/**
 * Split findings into the ones that still refuse the write and the ones the
 * caller has declared correct.
 *
 * Declaring is per finding, not per proposal: saying `agnes-2.5-flash` is free
 * is not a statement about `agnes-3.0-flash`, and a model that acknowledged the
 * prices on one row should not be read as having acknowledged them on the next.
 */
export function partitionFindings(
  findings: Finding[],
  rawConfirmed: unknown,
): { blocking: Finding[]; acknowledged: Finding[] } {
  const confirmed = new Set(
    Array.isArray(rawConfirmed)
      ? rawConfirmed.filter((v): v is string => typeof v === "string")
      : [],
  );
  const blocking: Finding[] = [];
  const acknowledged: Finding[] = [];
  for (const f of findings) {
    if (!f.blocking) continue;
    (confirmed.has(findingKey(f.code, f.clientId)) ? acknowledged : blocking).push(f);
  }
  return { blocking, acknowledged };
}

/**
 * What the model is told when a write is refused.
 *
 * The previous wording ended with "确认无误就再说一次，我按你说的值提交", and
 * saying it again returned the identical refusal — the model followed the advice
 * three times and then correctly concluded it was stuck. A refusal that names no
 * way out is not a check, it is a wall, and this one sat between the assistant
 * and a configuration it was being asked to fix.
 *
 * So the three real ways out are listed, and the middle one is the honest answer
 * for a model that really is free: the operator has the authority to declare it,
 * this is where that authority is exercised, and it lands on the proposal as a
 * recorded acknowledgement rather than as a silent value.
 */
export function renderFindingsRefusal(blocking: Finding[], all: Finding[]): string {
  const reminders = all.length - blocking.length;
  return (
    `这份配置里有 ${blocking.length} 处需要你确认，我先没有提交：\n` +
    `${describeFindings(blocking).join("\n")}\n` +
    (reminders > 0 ? `（另有 ${reminders} 条提醒，提交后会附在提案里。）\n` : "") +
    `三条路，选一条：\n` +
    `  1. 改值 —— 把上面指出的字段改对再提。\n` +
    `  2. 声明确实如此 —— 在 confirmFindings 里加上上面方括号里的「code:模型名」，` +
    `例如 ${findingKey("all_zero", blocking[0].clientId)}。` +
    `我会按你说的提交，并在提案里记明这是你确认过的，不是默认值。\n` +
    `  3. 由管理员在界面上直接改 —— 那条路不经过我。\n` +
    `（不要再原样重发一遍：同样的内容会得到同样的拒绝。）`
  );
}
