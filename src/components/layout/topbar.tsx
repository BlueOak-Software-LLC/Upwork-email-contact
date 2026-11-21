import { Badge } from "@/components/ui/badge";
import { signOut } from "@/app/(dashboard)/actions";

export function Topbar({
  title,
  subtitle,
  user,
}: {
  title: string;
  subtitle?: string;
  user?: { email?: string } | null;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface/60 px-5 py-4 backdrop-blur">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
      </div>

      <div className="flex items-center gap-3">
        <Badge tone={user ? "brand" : "warn"}>
          {user?.email ?? "anonymous (dev mode)"}
        </Badge>
        {user ? (
          <form action={signOut}>
            <button
              type="submit"
              className="text-sm text-muted transition hover:text-ink focus-ring"
            >
              Sign out
            </button>
          </form>
        ) : (
          <a
            href="/login"
            className="text-sm text-muted transition hover:text-ink focus-ring"
          >
            Sign in
          </a>
        )}
      </div>
    </header>
  );
}
