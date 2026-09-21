import Link from "next/link";

/**
 * Site-wide footer.
 *
 * - Single source of truth for the project license attribution.
 * - No project version is shown anywhere in this footer.
 * - The GitHub link is opt-in via NEXT_PUBLIC_REPOSITORY_URL so the footer
 *   doesn't break for self-hosted deployments without a public repo.
 */
export function Footer() {
  const year = new Date().getFullYear();
  const repoUrl = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim();

  return (
    <footer className="mt-auto border-t border-slate-200 bg-slate-50">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-4 text-xs text-slate-500 sm:flex-row">
        <div>
          © {year} CloudyAasim · Released under the{" "}
          <Link
            href="/license"
            className="font-medium text-slate-700 underline-offset-2 hover:underline"
          >
            MIT License
          </Link>
        </div>
        {repoUrl ? (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-slate-700 underline-offset-2 hover:underline"
          >
            Source on GitHub ↗
          </a>
        ) : null}
      </div>
    </footer>
  );
}
