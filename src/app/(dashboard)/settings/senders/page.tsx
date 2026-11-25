import { SendersView } from "@/components/settings/senders-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Senders & profile" };

export default function SendersPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-muted">Sender accounts</h2>
        <p className="text-xs text-muted/80">
          The two mailboxes we send <em>from</em>, each with its own SMTP server.
        </p>
      </div>
      <SendersView />
    </div>
  );
}
