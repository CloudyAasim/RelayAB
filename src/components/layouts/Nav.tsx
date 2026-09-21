import Link from "next/link";
import { logoutAction } from "@/app/(auth)/logout-action";
import { Badge } from "@/components/ui/Badge";

interface NavProps {
  username: string;
  role: "admin" | "user";
}

export function Nav({ username, role }: NavProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-lg font-semibold tracking-tight text-brand-700">
            RelayAB
          </Link>
          <div className="hidden gap-4 sm:flex">
            {role === "user" && (
              <Link
                href="/dashboard"
                className="text-sm font-medium text-slate-600 hover:text-slate-900"
              >
                Dashboard
              </Link>
            )}
            {role === "admin" && (
              <>
                <Link
                  href="/admin"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Overview
                </Link>
                <Link
                  href="/admin/users"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Users
                </Link>
                <Link
                  href="/admin/keys"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Keys
                </Link>
                <Link
                  href="/admin/providers"
                  className="text-sm font-medium text-slate-600 hover:text-slate-900"
                >
                  Providers
                </Link>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-slate-600">{username}</span>
          <Badge tone={role === "admin" ? "purple" : "slate"}>{role}</Badge>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
            >
              Logout
            </button>
          </form>
        </div>
      </nav>
    </header>
  );
}
