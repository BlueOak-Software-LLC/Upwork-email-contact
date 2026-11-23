import Link from "next/link";
import type { LeadContactRow } from "@/types/lead";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { formatDate, truncate } from "@/lib/utils";

const LIST_LABEL: Record<string, string> = {
  verified: "Verified",
  potential: "Potential",
  company_page: "Company page",
  linkedin: "LinkedIn",
  social: "Social",
  key_person: "Key person",
};

/**
 * Every channel we found for the lead. Email rows are the ones that can be
 * turned into a proposal + draft; the rest are research links.
 */
export function ContactsList({ contacts }: { contacts: LeadContactRow[] }) {
  if (contacts.length === 0) {
    return (
      <p className="rounded-lg bg-canvas p-4 text-sm text-muted">
        The payload carried no contacts.
      </p>
    );
  }

  const groups = contacts.reduce<Record<string, LeadContactRow[]>>((acc, contact) => {
    (acc[contact.list_type] ??= []).push(contact);
    return acc;
  }, {});

  return (
    <div className="space-y-5">
      {Object.entries(groups).map(([listType, items]) => (
        <section key={listType}>
          <div className="mb-2 flex items-center gap-2">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
              {LIST_LABEL[listType] ?? listType}
            </h4>
            <span className="text-[11px] text-muted/70">{items.length}</span>
          </div>

          <ul className="space-y-2">
            {items.map((contact) => (
              <li key={contact.id} className="rounded-lg border border-line bg-canvas p-3">
                <div className="flex flex-wrap items-center gap-2">
                  {contact.is_email ? (
                    <Badge tone="brand">email</Badge>
                  ) : (
                    <Badge>{contact.channel}</Badge>
                  )}
                  {contact.confidence ? <StatusBadge status={contact.confidence} /> : null}
                  {contact.is_primary ? <Badge tone="warn">primary</Badge> : null}
                  <span className="ml-auto text-[11px] text-muted/70">
                    {formatDate(contact.created_at)}
                  </span>
                </div>

                <div className="mt-2 text-sm">
                  {contact.is_email ? (
                    <a
                      href={`mailto:${contact.normalized_value ?? contact.contact_value}`}
                      className="font-medium text-brand hover:underline"
                    >
                      {contact.normalized_value ?? contact.contact_value}
                    </a>
                  ) : contact.channel === "url" ? (
                    <Link
                      href={contact.contact_value}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-medium text-ink/90 hover:text-brand"
                    >
                      {truncate(contact.contact_value, 70)}
                    </Link>
                  ) : (
                    <span className="font-medium">{contact.contact_value}</span>
                  )}
                </div>

                {(contact.name || contact.role || contact.company) && (
                  <div className="mt-1 text-xs text-muted">
                    {[contact.name, contact.role, contact.company]
                      .filter(Boolean)
                      .join(" · ")}
                    {contact.contact_type ? ` · ${contact.contact_type}` : ""}
                  </div>
                )}

                {contact.rationale ? (
                  <p className="mt-2 border-l-2 border-line pl-3 text-xs text-muted/80">
                    {truncate(contact.rationale, 320)}
                  </p>
                ) : null}

                {contact.source_url ? (
                  <a
                    href={contact.source_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="mt-2 inline-block text-[11px] text-muted underline-offset-2 hover:text-brand hover:underline"
                  >
                    source ↗
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
