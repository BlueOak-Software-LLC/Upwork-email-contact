import { notFound } from "next/navigation";
import { LeadConsole } from "@/components/leads/lead-console";
import { leadsRepo } from "@/server/db/leads.repo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Lead · Upwork Outreach" };

/**
 * Server gate for one lead: resolve it (404 honestly) and hand the payload to
 * the client console, which owns the data from then on. First paint is still
 * server-rendered — the difference is that later changes update in place
 * instead of needing a browser refresh.
 */
export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const detail = await leadsRepo.detail(id).catch(() => null);
  if (!detail) notFound();

  return <LeadConsole leadId={id} initial={detail} />;
}
