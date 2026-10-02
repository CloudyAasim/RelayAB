"use client";

/**
 * src/lib/assistant/CredentialPanel.tsx
 *
 * The switch and the mode selector, shared by the assistant settings drawer and
 * the model test page so the two cannot drift apart.
 *
 * What it shows, in order of how likely it is to matter to someone reading it:
 * the account switch first (it is the zero-friction path and the one that
 * decides whether anything works at all), then the key field for people who
 * would rather paste something they can revoke by deleting it.
 *
 * Deliberately not a "reveal secret" control. There is no secret: the
 * credential's plaintext is never generated, so the only thing this panel can
 * honestly offer is create / switch on / switch off / rebuild / remove.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { apiErrorMessage } from "@/lib/i18n/api-errors";

export type CredentialState = {
  created: boolean;
  enabled: boolean;
  keyPrefix: string | null;
  createdAt: string | null;
  usable: boolean;
};

export type Mode = "account" | "key";

const EMPTY: CredentialState = { created: false, enabled: false, keyPrefix: null, createdAt: null, usable: false };

interface Props {
  /** Current selection, and how to report a change to the parent. */
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  /** The pasted-key field value, owned by the parent so the send path can use it. */
  relayKey: string;
  onRelayKeyChange: (value: string) => void;
  /** Set when the panel should be usable; the assistant hides it until configured. */
  disabled?: boolean;
  /**
   * Why the account path is unavailable *here*, when the reason is not simply
   * "you have not switched it on". The media tester passes this for speech
   * recognition, which takes an uploaded file and so only works on the key
   * path - a capability that quietly fell back to a hidden key would be worse
   * than one that says so.
   */
  accountBlockedReason?: string | null;
  /** Fired after any change, so the parent can refresh whatever it caches. */
  onChanged?: () => void;
}

export function CredentialPanel({
  mode,
  onModeChange,
  relayKey,
  onRelayKeyChange,
  disabled,
  accountBlockedReason,
  onChanged,
}: Props) {
  const t = useT();
  const [state, setState] = useState<CredentialState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the account option has ever been picked on purpose. Until it has,
   * the panel is allowed to move the selection itself - see the effect below.
   */
  const userPickedRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/assistant/credentials", { cache: "no-store" });
      const json = (await res.json().catch(() => null)) as {
        data?: CredentialState;
        error?: { code?: string; message?: string };
      } | null;
      if (res.ok && json?.data) setState(json.data);
      else setState(EMPTY);
    } catch {
      setState(EMPTY);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blockedReason = accountBlockedReason ?? null;
  const canUseAccount = state.created && state.enabled && !blockedReason;

  /**
   * Never leave the page resting on an option that cannot be chosen.
   *
   * The initial mode is "account" because that is the path worth taking, but
   * for someone who has not created a credential it is disabled - and because
   * the key field is hidden while it is selected, the page came up looking like
   * it had no way to run anything at all. Once the real state is known, fall
   * back to the key path, unless the user has already chosen for themselves:
   * their choice is not ours to second-guess when it is still available.
   */
  useEffect(() => {
    if (!loaded) return;
    if (!canUseAccount && mode === "account" && !userPickedRef.current) onModeChange("key");
    // Once the account path becomes available again, follow it - that is the
    // point of creating it.
    if (canUseAccount && mode === "key" && !relayKey.trim() && !userPickedRef.current) {
      onModeChange("account");
    }
  }, [loaded, canUseAccount, mode, onModeChange, relayKey]);

  const choose = useCallback(
    (next: Mode) => {
      userPickedRef.current = true;
      onModeChange(next);
    },
    [onModeChange],
  );

  async function act(action: "create" | "enable" | "disable" | "rotate" | "remove") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch("/api/assistant/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json().catch(() => null)) as {
        data?: CredentialState;
        error?: { code?: string; message?: string };
      } | null;
      if (!res.ok || !json?.data) {
        setError(apiErrorMessage(t, json?.error?.code, json?.error?.message));
        return;
      }
      setState(json.data);
      // Turning it on is the moment the account path becomes usable, so the
      // selection follows rather than leaving the user on a dead option.
      if (action === "enable") choose("account");
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* ---- the account switch ---- */}
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{t("assistant.credential.switch")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("assistant.credential.switchHint")}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("assistant.credential.switch")}
            checked={state.enabled}
            disabled={disabled || busy !== null || !state.created}
            onChange={(e) => void act(e.target.checked ? "enable" : "disable")}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-input text-primary focus:ring-ring disabled:opacity-50"
          />
        </div>

        {!loaded ? null : !state.created ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t("assistant.credential.notCreated")}</p>
            <Button size="sm" disabled={disabled || busy !== null} onClick={() => void act("create")}>
              {busy === "create" ? t("assistant.credential.creating") : t("assistant.credential.create")}
            </Button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {state.keyPrefix}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busy !== null}
              onClick={() => void act("rotate")}
              title={t("assistant.credential.rotateHint")}
            >
              {busy === "rotate" ? t("assistant.credential.rotating") : t("assistant.credential.rotate")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy !== null}
              onClick={() => void act("remove")}
            >
              {t("assistant.credential.remove")}
            </Button>
          </div>
        )}
      </div>

      {/* ---- which credential the next call uses ---- */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">{t("assistant.credential.which")}</legend>

        <label
          className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${
            mode === "account" ? "border-primary bg-accent" : "border-border"
          } ${canUseAccount ? "" : "opacity-50"}`}
        >
          <input
            type="radio"
            name="assistant-credential-mode"
            className="mt-0.5"
            checked={mode === "account"}
            disabled={!canUseAccount}
            onChange={() => choose("account")}
          />
          <span>
            {t("assistant.credential.modeAccount")}
            {!canUseAccount && (
              <span className="block text-xs text-muted-foreground">
                {blockedReason ?? t("assistant.credential.modeAccountLocked")}
              </span>
            )}
          </span>
        </label>

        <label
          className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${
            mode === "key" ? "border-primary bg-accent" : "border-border"
          }`}
        >
          <input
            type="radio"
            name="assistant-credential-mode"
            className="mt-0.5"
            checked={mode === "key"}
            onChange={() => choose("key")}
          />
          <span>{t("assistant.credential.modeKey")}</span>
        </label>
      </fieldset>

      {mode === "key" && (
        <div className="space-y-1.5">
          <label htmlFor="assistant-relay-key" className="block text-sm font-medium text-foreground">
            {t("assistant.credential.keyLabel")}
          </label>
          <input
            id="assistant-relay-key"
            type="password"
            autoComplete="off"
            placeholder="sk-relay-..."
            value={relayKey}
            onChange={(e) => onRelayKeyChange(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t("assistant.credential.keyHint")}</p>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{error}</p>
      )}
    </div>
  );
}
