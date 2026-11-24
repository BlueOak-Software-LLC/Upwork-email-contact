"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

import { NAV } from "./nav";
import { truncate } from "@/lib/utils";

export type ShellBrand = { company: string; byline: string; initials: string };

export function Sidebar({ brand }: { brand?: ShellBrand }) {
  const pathname = usePathname();

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand text-[11px] font-bold tracking-tight text-brand-ink shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-brand)_18%,transparent)]">
          {brand?.initials ?? "U"}
        </span>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold">Email Contact</div>
          <div className="truncate text-[11px] text-muted">
            {brand?.company ? truncate(brand.company, 22) : "Upwork outreach"}
          </div>
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
                "flex items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm transition focus-ring",
                active
                  ? "border-brand/25 bg-brand/12 font-medium text-brand shadow-[inset_2px_0_0_var(--color-brand)]"
                  : "text-muted hover:border-line-soft hover:bg-surface-2 hover:text-ink",
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

      {/* `pb-14` keeps the last line clear of the Next.js dev badge, which sits
          in this corner in `npm run dev` only. */}
      <div className="space-y-1 border-t border-line-soft px-5 pt-4 pb-14 text-[11px] text-muted">
        {brand?.byline ? <div className="truncate text-faint">{brand.byline}</div> : null}
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-brand" />
          Supabase + Vercel
        </div>
      </div>
    </aside>
  );
}
