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

/**
 * The account switch and its lifecycle: create, enable, disable, rebuild,
 * remove.
 *
 * This is an account-level decision - "may the assistant spend my quota on my
 * behalf" - so it lives in the settings screen next to the other things that
 * are about the account rather than about one screen. It used to sit in the
 * assistant's drawer, where it was buried under a model configuration and
 * looked like a per-conversation option.
 */
export function AccountCredentialPanel({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const { data: state, loaded, busy, error, mutate, refreshServer } = useCredentialStore();

  const act = useCallback(
    async (action: CredentialAction) => {
      const ok = await mutate(action);
      if (!ok) return;
      // The admin's key list is a server component, so nothing it renders moves
      // until the page is re-fetched.
      refreshServer();
      onChanged?.();
    },
    [mutate, refreshServer, onChanged],
  );

  // The state in words, so it never has to be inferred from a checkbox - and so
  // the difference between "not created" and "created but off" is visible
  // before anyone touches anything.
  const status = !loaded
    ? t("assistant.credential.status.loading")
    : !state.created
      ? t("assistant.credential.status.none")
      : state.enabled
        ? t("assistant.credential.status.on")
        : t("assistant.credential.status.off");

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-sm font-medium text-foreground">{t("assistant.credential.switch")}</p>
              {/* Set apart from the label: "允许助手用我的账号调用 已开启" ran
                  together as one phrase, and the state is the part worth
                  noticing. A pill rather than a recoloured word, so it reads
                  as a status and not as part of the title. */}
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  state.enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}
              >
                {status}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("assistant.credential.switchHint")}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("assistant.credential.switch")}
            aria-busy={busy !== null}
            checked={state.enabled}
            disabled={busy !== null || !state.created}
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
            <Button size="sm" disabled={busy !== null} onClick={() => void act("create")}>
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
              disabled={busy !== null}
              onClick={() => void act("rotate")}
              title={t("assistant.credential.rotateHint")}
            >
              {busy === "rotate" ? t("assistant.credential.rotating") : t("assistant.credential.rotate")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void act("remove")}
            >
              {busy === "remove" ? t("assistant.credential.removing") : t("assistant.credential.remove")}
            </Button>
          </div>
        )}
      </div>

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

/**
 * Which credential the next call on this screen uses.
 *
 * Stays with the screen that spends it. The switch that decides whether account
 * calls are allowed at all lives in the settings screen; this is just the
 * per-screen choice between that account and a key the user pastes here.
 */
export function CredentialChoice({
  mode,
  onModeChange,
  relayKey,
  onRelayKeyChange,
  accountBlockedReason,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  relayKey: string;
  onRelayKeyChange: (value: string) => void;
  accountBlockedReason?: string | null;
}) {
  const t = useT();
  const { data: state, loaded } = useCredentialStore();
  /**
   * Per instance, and both of them.
   *
   * The radio `name` was a constant, which is invisible until the page mounts
   * two of these: the model test page has a chat tester and a media tester, and
   * the assistant drawer has a third. Native radio grouping is by name across
   * the whole document, not by component, so picking one option in one panel
   * silently unchecked the identically named radio in the others — while each
   * panel's `checked` is controlled by its own state and knew nothing about it.
   * The result was a dot on screen that did not match the state the next call
   * would be made with.
   *
   * `useId` is already how the key field's id is made unique, one line down, for
   * the same reason and on the same page.
   */
  const instanceId = useId();
  const keyFieldId = `${instanceId}-key`;
  const modeGroup = `${instanceId}-mode`;

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

  const accountLook = optionAppearance({ selected: mode === "account", available: canUseAccount });
  const keyLook = optionAppearance({ selected: mode === "key", available: true });

  return (
    <div className="space-y-3">

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
                {blockedReason ?? (
                  /* The pointer belongs on the disabled option itself: that is
                     where the reader is looking, and a paragraph elsewhere left
                     the radio looking broken rather than unavailable. */
                  <>
                    {t("assistant.credential.modeAccountLocked")}{" "}
                    <a href="/dashboard/settings" className="text-primary underline underline-offset-2">
                      {t("settings.assistantCredential.title")}
                    </a>
                  </>
                )}
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
    </div>
  );
}
