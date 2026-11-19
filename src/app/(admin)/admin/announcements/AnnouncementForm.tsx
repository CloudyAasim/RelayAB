"use client";

/**
 * app/(admin)/admin/announcements/AnnouncementForm.tsx
 *
 * The editor for one announcement: what it says, how loud it is, and how long it
 * is meant to matter.
 *
 * Three of the fields are about the same idea, so they are grouped and explained
 * once: `level` is the colour, `pinned` is the position, and the two dates are
 * the window. None of them can hide a notice on its own — `enabled` is the only
 * switch that does that, and it sits apart for exactly that reason.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Input, Textarea } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { SwitchField } from "@/components/ui/Switch";
import { FormFooter, FormStatus } from "@/components/ui/FormStatus";
import { Button } from "@/components/ui/Button";
import { useT } from "@/components/i18n/I18nProvider";
import { ANNOUNCEMENT_LEVELS, type AnnouncementLevel } from "@/lib/announcements/types";
import { Save } from "lucide-react";

/** A row as the table holds it — the admin sees every field, so all of them. */
export interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  level: AnnouncementLevel;
  pinned: boolean;
  enabled: boolean;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  /** Present → edit mode (PATCH); absent → create mode (POST). */
  announcement?: AnnouncementRow;
  onSaved?: () => void;
}

export function AnnouncementForm({ announcement, onSaved }: Props) {
  const t = useT();
  const router = useRouter();
  const editing = Boolean(announcement);

  const [title, setTitle] = useState(announcement?.title ?? "");
  const [body, setBody] = useState(announcement?.body ?? "");
  const [level, setLevel] = useState<AnnouncementLevel>(announcement?.level ?? "info");
  const [pinned, setPinned] = useState(announcement?.pinned ?? false);
  const [enabled, setEnabled] = useState(announcement?.enabled ?? true);
  const [startsAt, setStartsAt] = useState(toLocalInput(announcement?.startsAt ?? null));
  const [endsAt, setEndsAt] = useState(toLocalInput(announcement?.endsAt ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const payload = {
        title,
        body,
        level,
        pinned,
        enabled,
        // Empty means "no bound on this side", which the API reads as null.
        startsAt: startsAt || null,
        endsAt: endsAt || null,
      };
      const res = await fetch(
        editing
          ? `/api/admin/announcements/${announcement!.id}`
          : "/api/admin/announcements",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = await res.json();
      if (!data.ok) {
        setError(data.error?.message ?? t("common.failed"));
        return;
      }
      setSaved(true);
      onSaved?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Input
        label={t("admin.announcements.titleLabel")}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        required
        maxLength={120}
      />

      <Textarea
        label={t("admin.announcements.body")}
        labelHint={t("admin.announcements.bodyHint")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        required
      />

      <Select
        label={t("admin.announcements.level")}
        labelHint={t("admin.announcements.levelHint")}
        name="announcement-level"
        value={level}
        onChange={(e) => setLevel(e.target.value as AnnouncementLevel)}
      >
        {ANNOUNCEMENT_LEVELS.map((value) => (
          <option key={value} value={value}>
            {t(`announcements.level.${value}`)}
          </option>
        ))}
      </Select>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("admin.announcements.startsAt")}
          labelHint={t("admin.announcements.windowHint")}
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
        />
        <Input
          label={t("admin.announcements.endsAt")}
          type="datetime-local"
          value={endsAt}
          onChange={(e) => setEndsAt(e.target.value)}
        />
      </div>

      <SwitchField
        id="announcement-pinned"
        label={t("admin.announcements.pinned")}
        description={t("admin.announcements.pinnedHint")}
        checked={pinned}
        onCheckedChange={setPinned}
      />

      <SwitchField
        id="announcement-enabled"
        label={t("admin.announcements.enabled")}
        description={t("admin.announcements.description")}
        checked={enabled}
        onCheckedChange={setEnabled}
      />

      <FormStatus error={error} saved={saved} savedText={t("admin.announcements.saved")} />

      <FormFooter>
        <Button type="button" loading={busy} onClick={save}>
          <Save className="mr-1.5 h-4 w-4" />
          {t("common.save")}
        </Button>
      </FormFooter>
    </div>
  );
}

/**
 * A stored instant → the local `YYYY-MM-DDTHH:mm` a `datetime-local` input wants.
 *
 * Same conversion the API key editor uses: the browser's clock is the zone the
 * operator is typing in, so the form has to speak it, while the row keeps UTC.
 */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}