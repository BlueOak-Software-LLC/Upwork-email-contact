import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { LiveRefresh } from "@/components/layout/live-refresh";
import { createClient } from "@/lib/supabase/server";

/**
 * Dashboard shell (route group `(dashboard)` → no URL segment).
 * Server Component: reads the session directly, then renders the client islands.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));

  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <LiveRefresh />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:text-brand-ink"
        >
          Skip to content
        </a>
        <Topbar
          title="Upwork Email Contact"
          subtitle="Contacts, funnel and delivery log"
          user={user ? { email: user.email ?? undefined } : null}
        />
        <main id="main" className="flex-1 space-y-6 p-4 md:p-5">
          {children}
        </main>
      </div>
    </div>
  );
}
