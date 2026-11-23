import { ContactsView } from "@/components/contacts/contacts-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Contacts" };

export default function ContactsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-medium text-muted">Contacts</h2>
        <p className="text-xs text-muted/80">
          The CRM table you maintain by hand (<code>public.contacts</code>). Addresses we extracted
          from a payload live per lead instead — under <b>Found channels</b> on any lead, with a
          one-click “add to contacts list”.
        </p>
      </div>
      <ContactsView />
    </div>
  );
}
