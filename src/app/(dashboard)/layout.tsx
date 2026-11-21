import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
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
        <Topbar
          title="Upwork Email Contact"
          subtitle="Contacts, funnel and delivery log"
          user={user ? { email: user.email ?? undefined } : null}
        />
        <main className="flex-1 space-y-6 p-5">{children}</main>
      </div>
    </div>
  );
}
