"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { signOut } from "@/app/(dashboard)/actions";
import { NAV } from "./nav";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Responsive header: title, identity, sign out, and — below `md` — the drawer
 * that replaces the desktop sidebar, so the whole platform is reachable from a
 * phone instead of only from a wide window.
 */
export function Topbar({
  title,
  subtitle,
  user,
}: {
  title: string;
  subtitle?: string;
  user?: { email?: string } | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface/80 px-4 py-3 backdrop-blur md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open navigation"
            aria-expanded={open}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition hover:text-ink focus-ring md:hidden"
          >
            ☰
          </button>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold tracking-tight md:text-lg">{title}</h1>
            {subtitle ? <p className="truncate text-xs text-muted md:text-sm">{subtitle}</p> : null}
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3">
          <Badge tone={user ? "brand" : "warn"} className="max-w-[46vw] truncate sm:max-w-none">
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
            <a href="/login" className="text-sm text-muted transition hover:text-ink focus-ring">
              Sign in
            </a>
          )}
        </div>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <nav className="animate-pop-in absolute inset-y-0 left-0 w-64 border-r border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Email Contact</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close navigation"
                className="rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-ink focus-ring"
              >
                ✕
              </button>
            </div>
            <div className="mt-4 space-y-1">
              {NAV.map((item) => {
                const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition focus-ring",
                      active
                        ? "bg-brand/12 font-medium text-brand"
                        : "text-muted hover:bg-surface-2 hover:text-ink",
                    )}
                    aria-current={active ? "page" : undefined}
                  >
                    <span aria-hidden className="w-4 text-center">
                      {item.icon}
                    </span>
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>
        </div>
      ) : null}
    </>
  );
}
