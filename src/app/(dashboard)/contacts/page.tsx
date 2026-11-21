import { ContactsView } from "@/components/contacts/contacts-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

export default function ContactsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-muted">Contacts</h2>
        <p className="text-xs text-muted/80">
          Server-rendered shell, client-side table fed by{" "}
          <code>GET /api/contacts</code> through TanStack Query.
        </p>
      </div>
      <ContactsView />
    </div>
  );
}
