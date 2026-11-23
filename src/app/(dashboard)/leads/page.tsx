import { LeadsView } from "@/components/leads/leads-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leads" };

export default function LeadsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-muted">Ingested leads</h2>
        <p className="text-xs text-muted/80">
          Every object posted to <code>POST /api/leads</code> lands here — click a row
          for the job description, contacts, proposal and draft.
        </p>
      </div>
      <LeadsView />
    </div>
  );
}
