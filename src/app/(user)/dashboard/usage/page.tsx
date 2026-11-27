/**
 * The usage view now lives on `/dashboard`, so this route only forwards.
 *
 * Kept rather than deleted because old bookmarks and the previous
 * `relay_usage_view_user` links carry query strings (`?range=7d&scope=key...`)
 * that name a real view; dropping the route would turn those into 404s and
 * silently reset the reader to the default range.
 */
import { redirect } from "next/navigation";

interface UsagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function UsagePage({ searchParams }: UsagePageProps) {
  const sp = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    // `reset=1` is a command to the filters, not a filter: forwarded to the
    // dashboard it would clear the very view the redirect was meant to keep.
    if (key === "reset") continue;
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value)) for (const item of value) params.append(key, item);
  }
  const query = params.toString();
  redirect(query ? `/dashboard?${query}` : "/dashboard");
}