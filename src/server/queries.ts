import { contactsRepo } from "@/server/db/contacts.repo";
import type { ListContactsQuery } from "@/lib/validation/contact";
import type { Contact } from "@/types/domain";

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
