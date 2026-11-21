"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: "◧" },
  { href: "/contacts", label: "Contacts", icon: "◉" },
  { href: "/emails", label: "Email log", icon: "✉" },
  { href: "/api-docs", label: "API", icon: "{}" },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-sm font-bold text-brand-ink">
          U
        </span>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Email Contact</div>
          <div className="text-[11px] text-muted">Upwork outreach</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 px-3" aria-label="Main">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
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
      </nav>

      <div className="px-5 py-4 text-[11px] text-muted">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          Supabase + Vercel
        </div>
      </div>
    </aside>
  );
}
