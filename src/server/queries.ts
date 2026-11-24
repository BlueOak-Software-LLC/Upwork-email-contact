import { contactsRepo } from "@/server/db/contacts.repo";
import { trackingRepo } from "@/server/db/tracking.repo";
import { getAdminClient } from "@/lib/supabase/admin";
import { logger } from "@/lib/logger";
import type { ListContactsQuery } from "@/lib/validation/contact";
import type { Contact } from "@/types/domain";
import { trackingOrigin } from "@/lib/env";
import { pixelUrl } from "@/server/services/tracking/token";

/** Server-Component helpers (RSC reads, no HTTP hop to our own API). */
export async function getContacts(query: Partial<ListContactsQuery> = {}) {
  return contactsRepo.list({
    page: 1,
    pageSize: 20,
    sort: "created_at",
    order: "desc",
    ...query,
  } as ListContactsQuery);
}

export async function getContact(id: string): Promise<Contact> {
  return contactsRepo.byId(id);
}

export async function getMetrics() {
  return contactsRepo.metrics();
}

export async function getRecentContacts(limit = 6) {
  return contactsRepo
    .list({ page: 1, pageSize: limit, sort: "created_at", order: "desc" } as ListContactsQuery)
    .then((r) => r.items);
}

/**
 * The pixel address of one delivered message, for the dashboard to show.
 *
 * Read-only and server-side: a browser that loaded this string would record an
 * open for the recipient, which is why it is rendered as text and never as an
 * `<img src>`.
 */
export function trackingPixelHint(token: string | null | undefined): string {
  if (!token) return "untracked";
  try {
    return pixelUrl(trackingOrigin(), token);
  } catch {
    // A broken env must not take a page down — the row is still worth showing.
    return `/o/${token}.gif`;
  }
}

/**
 * Tracking numbers for the Overview. Returns null instead of throwing: a
 * database that has not applied 0005 yet should show the rest of the dashboard
 * with a reason, not a 500 page.
 */
export async function getTrackingOverview(days = 7) {
  try {
    return await trackingRepo.stats(days);
  } catch (error) {
    logger.warn("tracking_overview_unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** One tracked message a reviewer can point the pixel self-test at. */
export async function getSampleTrackingToken() {
  try {
    const { data } = await getAdminClient()
      .from("email_logs")
      .select("tracking_token")
      .not("tracking_token", "is", null)
      .order("created_at", { ascending: false })
      .limit(1);
    return data?.[0]?.tracking_token ?? null;
  } catch {
    return null;
  }
}

/** Delivered, tracked, and still unread — the "follow up or move on" list. */
export async function getStaleSends(days = 7, limit = 6) {
  try {
    return await trackingRepo.staleSends(days, limit);
  } catch (error) {
    logger.warn("tracking_stale_sends_unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
