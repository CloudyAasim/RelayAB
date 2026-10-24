/**
 * The one place a key's status is drawn.
 *
 * There used to be two of them on the user's own page: a bare coloured dot in
 * the Status column, and a badge in the Actions column saying the same thing.
 * Same row, same fact, twice — and the two did not even agree: a key switched
 * off was a red dot beside a grey badge, and a key forced off by an admin was
 * a red dot beside an orange badge. Two answers, one question.
 *
 * So the status lives in the Status column, here, and the Actions column does
 * what its name says.
 *
 * This is a server component: it reads the locale cookie, and it must not be
 * turned into a client component — `lib/i18n/server` reaches for `next/headers`,
 * and a client module importing it fails the build.
 */
import { Badge } from "@/components/ui/Badge";
import { getT } from "@/lib/i18n/server";
import { keyStatus, type KeyStatusInput } from "@/lib/keys/status";

export async function KeyStatusBadge({ apiKey }: { apiKey: KeyStatusInput }) {
  const { t } = await getT();
  const status = keyStatus(apiKey);

  // One badge, one meaning. The tone is the colour, the text is the word: a
  // dot inside the badge would say it twice over, which is the thing this
  // component exists to stop.
  const tone =
    status === "forceDisabled"
      ? "orange"
      : status === "expired"
        ? "warning"
        : status === "enabled"
          ? "success"
          : "neutral";

  return (
    <Badge tone={tone}>
      {status === "forceDisabled"
        ? t("admin.keys.status.forceDisabled")
        : status === "expired"
          ? t("dashboard.status.expired")
          : status === "enabled"
            ? t("dashboard.status.enabled")
            : t("dashboard.status.disabled")}
    </Badge>
  );
}
