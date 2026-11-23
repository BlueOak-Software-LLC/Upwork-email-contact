"use client";

import { useMemo, useState } from "react";
import { useContacts, useDeleteContact } from "@/lib/api/hooks";
import type { Contact, ContactStatus } from "@/types/domain";
import { CONTACT_STATUSES } from "@/types/domain";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { CopyButton } from "@/components/ui/copy-button";
import { TimeAgo } from "@/components/ui/time-ago";
import { Input, Select } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/badge";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { TableSkeleton } from "@/components/ui/skeleton";
import { NewContactDialog } from "./new-contact-dialog";
import { SendEmailDialog } from "./send-email-dialog";

const PAGE_SIZE = 20;

export function ContactsView() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | ContactStatus>("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, Contact>>(new Map());
  const [composerOpen, setComposerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const filters = useMemo(
    () => ({ q: q || undefined, status: status || undefined, page, pageSize: PAGE_SIZE }),
    [q, status, page],
  );

  const { data, isLoading, isFetching, error, refetch } = useContacts(filters);
  const remove = useDeleteContact();

  const rows = data?.data ?? [];
  const meta = data?.meta;

  const toggle = (contact: Contact) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(contact.id)) next.delete(contact.id);
      else next.set(contact.id, contact);
      return next;
    });

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQ(search.trim());
            setPage(1);
          }}
        >
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email or company…"
            className="max-w-xs"
            aria-label="Search contacts"
          />
          <Button type="submit" variant="secondary" size="sm">
            Search
          </Button>
          <Select
            value={status}
            aria-label="Filter by status"
            className="w-36"
            onChange={(e) => {
              setStatus(e.target.value as "" | ContactStatus);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace("_", " ")}
              </option>
            ))}
          </Select>
        </form>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => refetch()} loading={isFetching}>
            Refresh
          </Button>
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setComposerOpen(true)}
          >
            Send email ({selected.size})
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            New contact
          </Button>
        </div>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton />
        ) : error ? (
          <EmptyState
            tone="danger"
            icon="✕"
            title="Contacts could not be loaded"
            description={
              <>
                {(error as Error).message} — is the migration applied and are the Supabase env vars
                set?
              </>
            }
            action={
              <Button size="sm" onClick={() => refetch()} loading={isFetching}>
                Try again
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No CRM contacts yet"
            description={
              <>
                This table is the list you keep by hand. Addresses found in an Upwork payload are
                stored on the lead (Found channels) and can be promoted here with one click.
              </>
            }
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                New contact
              </Button>
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allChecked}
                    onChange={() =>
                      setSelected(
                        allChecked
                          ? new Map()
                          : new Map(rows.map((r) => [r.id, r])),
                      )
                    }
                  />
                </Th>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Last contacted</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </THead>
            <TBody>
              {rows.map((contact) => (
                <Tr key={contact.id}>
                  <Td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${contact.name}`}
                      checked={selected.has(contact.id)}
                      onChange={() => toggle(contact)}
                    />
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1.5 font-medium">
                      {contact.name}
                      <CopyButton value={contact.email} size="icon" label="Copy email" />
                    </div>
                    <div className="text-xs text-muted">{contact.email}</div>
                  </Td>
                  <Td className="text-muted">
                    {contact.company ?? "—"}
                    {contact.role ? (
                      <div className="text-xs text-muted/70">{contact.role}</div>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge status={contact.status} />
                  </Td>
                  <Td className="text-muted">{contact.source}</Td>
                  <Td className="tabular text-muted">
                    {contact.last_contacted_at ? <TimeAgo value={contact.last_contacted_at} /> : "never"}
                  </Td>
                  <Td className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSelected(new Map([[contact.id, contact]]));
                        setComposerOpen(true);
                      }}
                    >
                      Email
                    </Button>
                    <ConfirmAction
                      label="Delete"
                      title={`Delete ${contact.email}?`}
                      description="The contact row is removed; email log entries that referenced it keep their history."
                      busy={remove.isPending && remove.variables === contact.id}
                      onConfirm={() => remove.mutate(contact.id)}
                    />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          {meta
            ? `${meta.total} contacts · page ${meta.page} of ${meta.totalPages}`
            : "—"}
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Prev
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!meta || page >= meta.totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>

      <SendEmailDialog
        open={composerOpen}
        recipients={[...selected.values()]}
        onClose={() => setComposerOpen(false)}
      />
      <NewContactDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
