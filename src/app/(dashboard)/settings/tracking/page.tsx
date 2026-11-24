import type { Metadata } from "next";
import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import { getServerEnv, linkTrackingEnabled, trackingOrigin } from "@/lib/env";
import { TrackingPanel } from "@/components/settings/tracking-panel";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tracking" };

/**
 * `/settings/tracking` — server-rendered configuration, client-rendered checks.
 *
 * The environment values are read here rather than shipped to the browser:
 * `TRACKING_DOMAIN` is fine to show, but the page must not become a place where
 * a secret leaks. The sample token below belongs to a message that already
 * exists and is already a secret in the recipient's inbox.
 */
export default async function TrackingSettingsPage() {
  const env = getServerEnv();

  const { data } = await getAdminClient()
    .from("email_logs")
    .select("id,tracking_token")
    .not("tracking_token", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);

  const sample = data?.[0]?.tracking_token ?? null;
  if (!data) logger.warn("tracking_sample_token_unavailable");

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium">Email tracking</h2>
        <p className="text-xs text-muted/80">
          Every send carries a 1×1 image addressed to this deployment, and every URL in the body can
          be rewritten to a redirect. Both are how the numbers on the Overview mean anything.
        </p>
      </div>

      <TrackingPanel
        env={{
          EMAIL_TRACKING: env.EMAIL_TRACKING,
          LINK_TRACKING: linkTrackingEnabled(env),
          provider: env.EMAIL_PROVIDER,
          domain: trackingOrigin(env),
          retentionDays: env.TRACKING_RETENTION_DAYS,
          production: env.NODE_ENV === "production",
        }}
        verificationToken={sample}
      />
    </div>
  );
}
