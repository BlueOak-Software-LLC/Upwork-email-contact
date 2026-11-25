import type { ReactNode } from "react";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar } from "@/components/layout/topbar";
import { LiveRefresh } from "@/components/layout/live-refresh";
import { ChatGptSessionProvider } from "@/components/chatgpt/session-provider";
import { ChatGptSessionDrawer } from "@/components/chatgpt/session-drawer";
import { brandConfig } from "@/lib/env-extras";
import { createClient } from "@/lib/supabase/server";

/**
 * Dashboard shell (route group `(dashboard)` → no URL segment).
 * Server Component: reads the session directly, then renders the client islands.
 */
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const brand = brandConfig();
  // The person who signs documents, shown in the shell so the sidebar tells
  // you which identity a proposal will carry before you generate one. There is
  // deliberately no company name anywhere in this shell.
  const name = brand.preparedBy || "Your profile";
  const identity = {
    name,
    byline: brand.title || "Add a sender profile to sign documents",
    initials:
      name
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0] ?? "")
        .join("")
        .toUpperCase()
        .slice(0, 2) || "U",
  };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));

  return (
    <ChatGptSessionProvider>
      <div className="flex min-h-dvh">
      <Sidebar brand={identity} />
      <div className="flex min-w-0 flex-1 flex-col">
        <LiveRefresh />
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[80] focus:rounded-lg focus:bg-brand focus:px-3 focus:py-2 focus:text-sm focus:text-brand-ink"
        >
          Skip to content
        </a>
        <Topbar
          brand={identity}
          title="Upwork Email Contact"
          subtitle="Contacts, funnel and delivery log"
          user={user ? { email: user.email ?? undefined } : null}
        />
        <main id="main" className="flex-1 space-y-6 p-4 md:p-5">
          {children}
        </main>
      </div>
      </div>
      <ChatGptSessionDrawer />
    </ChatGptSessionProvider>
  );
}
