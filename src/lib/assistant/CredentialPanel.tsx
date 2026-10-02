"use client";

/**
 * src/lib/assistant/CredentialPanel.tsx
 *
 * The switch, and the choice of which credential the next call uses. Shared by
 * the assistant settings drawer and both testers on the model test page, so
 * they cannot drift apart.
 *
 * What it offers, in order of how likely it is to matter: the account switch
 * first (it is the zero-friction path and it decides whether anything works at
 * all), then the key field for people who would rather hold something they can
 * revoke by deleting it.
 *
 * Deliberately not a "reveal secret" control. There is no secret: the
 * credential's plaintext is never generated, so the only honest thing to offer
 * is create / switch on / switch off / rebuild / remove.
 *
 * State comes from credential-store rather than from here: the page mounts two
 * of these, and creating a credential in one used to leave the other claiming
 * none existed until a full reload.
 */
import { useCallback, useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { useCredentialStore } from "./credential-store";
import type { CredentialAction } from "./credential-store";

export type Mode = "account" | "key";

/**
 * Which mode the panel should show, given what is known so far.
 *
 * Pulled out of the component because the rule is the whole point of the
 * panel and it is a decision, not a rendering detail: it is pure, so it can be
 * tested directly instead of being verified by clicking something in a browser.
 *
 *  - Before the state has loaded, leave the initial choice alone. Guessing here
 *    would flash the wrong thing at someone whose credential is fine.
 *  - The account path being unavailable is not a reason to sit on it. Landing
 *    on a disabled option, with the key field hidden because that option is
 *    selected, is what made the page look like it had no way to run anything.
 *  - But a choice the user actually made is theirs. Correcting it after they
 *    picked would be a worse bug than the one this fixes.
 */
export function reconcileMode(state: {
  loaded: boolean;
  canUseAccount: boolean;
  mode: Mode;
  /** True once the user has picked a mode themselves. */
  userPicked: boolean;
  /** Whether a pasted key is already sitting in the field. */
  hasKey: boolean;
}): Mode {
  const { loaded, canUseAccount, mode, userPicked, hasKey } = state;
  if (!loaded || userPicked) return mode;
  if (!canUseAccount && mode === "account") return "key";
  // A credential that has just been switched on is worth following, but not at
  // the cost of a key someone has already typed.
  if (canUseAccount && mode === "key" && !hasKey) return "account";
  return mode;
}

/**
 * How an option should look. Two states that used to be blended - "chosen" and
 * "chosen but unavailable" - are now separate, because an option that is both
 * reads as broken rather than as unavailable.
 *
 * `unavailable` never carries the selected colours. That is the bug: a dimmed
 * blue border and a dimmed tint on an option that cannot be picked looks like a
 * control that is on and broken.
 */
export function optionAppearance(state: {
  selected: boolean;
  available: boolean;
}): { selected: boolean; unavailable: boolean; className: string } {
  const { selected, available } = state;
  if (selected && available) {
    return {
      selected: true,
      unavailable: false,
      className: "border-primary bg-primary/5 ring-1 ring-primary",
    };
  }
  if (selected && !available) {
    // Shown as "you are here but cannot stay here" — a plain, quiet outline.
    return { selected: true, unavailable: true, className: "border-border bg-muted/40" };
  }
  if (!available) {
    return { selected: false, unavailable: true, className: "border-border opacity-60" };
  }
  return { selected: false, unavailable: false, className: "border-border" };
}

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
  /** Called after any change, in addition to the shared store updating. */
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
  const { data: state, loaded, busy, error, mutate, refreshServer } = useCredentialStore();
  const keyFieldId = useId();
  const modeGroup = "assistant-credential-mode";

  /**
   * Whether the account option has ever been picked on purpose. Until it has,
   * the panel is allowed to move the selection itself.
   */
  const userPickedRef = useRef(false);

  const blockedReason = accountBlockedReason ?? null;
  const canUseAccount = state.created && state.enabled && !blockedReason;

  useEffect(() => {
    const next = reconcileMode({
      loaded,
      canUseAccount,
      mode,
      userPicked: userPickedRef.current,
      hasKey: Boolean(relayKey.trim()),
    });
    if (next !== mode) onModeChange(next);
  }, [loaded, canUseAccount, mode, onModeChange, relayKey]);

  const choose = useCallback(
    (next: Mode) => {
      userPickedRef.current = true;
      onModeChange(next);
    },
    [onModeChange],
  );

  const act = useCallback(
    async (action: CredentialAction) => {
      const ok = await mutate(action);
      if (!ok) return;
      // Turning it on is the moment the account path becomes usable, so the
      // selection follows rather than leaving the user on a dead option.
      if (action === "enable") choose("account");
      // The admin's key list is a server component, so nothing it renders moves
      // until the page is re-fetched.
      refreshServer();
      onChanged?.();
    },
    [mutate, choose, refreshServer, onChanged],
  );

  const accountLook = optionAppearance({ selected: mode === "account", available: canUseAccount });
  const keyLook = optionAppearance({ selected: mode === "key", available: true });

  // The state of the switch in words, so it never has to be inferred from a
  // checkbox - and so the difference between "not created" and "created but
  // off" is visible before anyone touches anything.
  const status = !loaded
    ? t("assistant.credential.status.loading")
    : !state.created
      ? t("assistant.credential.status.none")
      : state.enabled
        ? t("assistant.credential.status.on")
        : t("assistant.credential.status.off");

  const statusTone = !loaded
    ? "text-muted-foreground"
    : !state.created
      ? "text-muted-foreground"
      : state.enabled
        ? "text-primary"
        : "text-muted-foreground";

  return (
    <div className="space-y-3">
      {/* ---- the account switch ---- */}
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-sm font-medium text-foreground">{t("assistant.credential.switch")}</p>
              <span className={`text-xs ${statusTone}`}>{status}</span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("assistant.credential.switchHint")}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("assistant.credential.switch")}
            aria-busy={busy !== null}
            checked={state.enabled}
            disabled={disabled || busy !== null || !state.created}
            onChange={(e) => void act(e.target.checked ? "enable" : "disable")}
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-input text-primary focus:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
          />
        </div>

        {/* Loading is a state, not an absence. The panel used to render
            nothing here until the fetch answered, which read as a component
            that had failed to render rather than one that was asking. */}
        {!loaded ? (
          <p className="mt-3 text-xs text-muted-foreground">{t("assistant.credential.status.loading")}</p>
        ) : !state.created ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
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
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={disabled || busy !== null}
              onClick={() => void act("remove")}
            >
              {busy === "remove" ? t("assistant.credential.removing") : t("assistant.credential.remove")}
            </Button>
          </div>
        )}
      </div>

      {/* ---- which credential the next call uses ---- */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">{t("assistant.credential.which")}</legend>

        <label
          className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${accountLook.className} ${
            canUseAccount ? "cursor-pointer" : "cursor-not-allowed"
          }`}
        >
          <input
            type="radio"
            name={modeGroup}
            className="mt-0.5 accent-primary"
            checked={mode === "account"}
            disabled={!canUseAccount}
            onChange={() => choose("account")}
          />
          <span>
            {t("assistant.credential.modeAccount")}
            {!canUseAccount && (
              <span className="block text-xs text-muted-foreground">
                {loaded
                  ? (blockedReason ?? t("assistant.credential.modeAccountLocked"))
                  : t("assistant.credential.status.loading")}
              </span>
            )}
          </span>
        </label>

        <label
          className={`flex cursor-pointer items-start gap-2 rounded-md border px-2.5 py-2 text-sm ${keyLook.className}`}
        >
          <input
            type="radio"
            name={modeGroup}
            className="mt-0.5 accent-primary"
            checked={mode === "key"}
            onChange={() => choose("key")}
          />
          <span>{t("assistant.credential.modeKey")}</span>
        </label>
      </fieldset>

      {mode === "key" && (
        <div className="space-y-1.5">
          <label htmlFor={keyFieldId} className="block text-sm font-medium text-foreground">
            {t("assistant.credential.keyLabel")}
          </label>
          <input
            id={keyFieldId}
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

      {/* Errors sit next to the thing that failed rather than at the bottom of
          the panel, where they read as belonging to the key field below. */}
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </div>
  );
}
