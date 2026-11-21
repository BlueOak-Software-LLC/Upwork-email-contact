import { getAdminClient } from "@/lib/supabase/admin";
import type {
  CreateContactInput,
  UpdateContactInput,
  ListContactsQuery,
} from "@/lib/validation/contact";
import type {
  Contact,
  ContactStatus,
  DashboardMetrics,
  Paged,
} from "@/types/domain";
import { CONTACT_STATUSES } from "@/types/domain";
import { ApiError } from "@/server/http/errors";
import { logger } from "@/lib/logger";

const CONTACT_COLUMNS =
  "id,name,email,company,role,status,source,tags,notes,last_contacted_at,created_at,updated_at";

/**
 * Data access for `public.contacts`.
 * Everything here runs with the service-role client, so RLS is bypassed on
 * purpose: the browser never reaches Postgres directly, only these functions.
 */
export const contactsRepo = {
  async list(query: ListContactsQuery): Promise<Paged<Contact>> {
    const supabase = getAdminClient();
    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;

    let builder = supabase
      .from("contacts")
      .select(CONTACT_COLUMNS, { count: "exact" })
      .order(query.sort, { ascending: query.order === "asc", nullsFirst: false })
      .range(from, to);

    if (query.status) builder = builder.eq("status", query.status);
    if (query.source) builder = builder.eq("source", query.source);
    if (query.tag) builder = builder.contains("tags", [query.tag]);
    if (query.q) {
      const term = query.q.replace(/[,%()]/g, " ").trim();
      if (term) {
        builder = builder.or(
          `name.ilike.%${term}%,email.ilike.%${term}%,company.ilike.%${term}%`,
        );
      }
    }

    const { data, error, count } = await builder;
    if (error) throw ApiError.upstream(`Failed to load contacts: ${error.message}`);

    const total = count ?? data?.length ?? 0;
    return {
      items: (data ?? []) as Contact[],
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  },

  async byId(id: string): Promise<Contact> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to load contact: ${error.message}`);
    if (!data) throw ApiError.notFound(`Contact ${id} not found`);
    return data as Contact;
  },

  async create(input: CreateContactInput): Promise<Contact> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("contacts")
      .insert(input)
      .select(CONTACT_COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") {
        throw ApiError.conflict(`A contact with ${input.email} already exists`);
      }
      throw ApiError.upstream(`Failed to create contact: ${error.message}`);
    }
    return data as Contact;
  },

  async update(id: string, patch: UpdateContactInput): Promise<Contact> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("contacts")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(CONTACT_COLUMNS)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to update contact: ${error.message}`);
    if (!data) throw ApiError.notFound(`Contact ${id} not found`);
    return data as Contact;
  },

  async remove(id: string): Promise<void> {
    const supabase = getAdminClient();
    const { error, count } = await supabase
      .from("contacts")
      .delete({ count: "exact" })
      .eq("id", id);

    if (error) throw ApiError.upstream(`Failed to delete contact: ${error.message}`);
    if (!count) throw ApiError.notFound(`Contact ${id} not found`);
  },

  /** Called after a successful send so the dashboard funnel stays accurate. */
  async markContacted(id: string, status: ContactStatus = "contacted") {
    const supabase = getAdminClient();
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("contacts")
      .update({ status, last_contacted_at: now, updated_at: now })
      .eq("id", id)
      .neq("status", "replied"); // never downgrade a reply

    if (error) logger.warn("mark_contacted_failed", { id, error: error.message });
  },

  async metrics(): Promise<DashboardMetrics> {
    const supabase = getAdminClient();
    const sevenDaysAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

    const [statusRes, emailRes, recentRes] = await Promise.all([
      supabase.from("contacts").select("id,status"),
      supabase
        .from("email_logs")
        .select("id,status,created_at")
        .gte("created_at", sevenDaysAgo),
      supabase
        .from("contacts")
        .select("created_at")
        .gte("created_at", sevenDaysAgo),
    ]);

    const errors = [statusRes, emailRes, recentRes].filter((r) => r.error);
    if (errors.length) {
      logger.warn("metrics_partial", {
        errors: errors.map((e) => e.error?.message),
      });
    }

    const contacts = (statusRes.data ?? []) as Array<Pick<Contact, "id" | "status">>;
    const byStatus = Object.fromEntries(
      CONTACT_STATUSES.map((s) => [s, 0]),
    ) as Record<ContactStatus, number>;
    for (const row of contacts) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

    const emails = (emailRes.data ?? []) as Array<{
      status: string;
      created_at: string;
    }>;

    const perDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      perDay.set(d, 0);
    }
    for (const row of recentRes.data ?? []) {
      const key = String(row.created_at).slice(0, 10);
      if (perDay.has(key)) perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }

    const replied = byStatus.replied ?? 0;
    const contactedOrMore =
      (byStatus.contacted ?? 0) + replied + (byStatus.no_reply ?? 0);

    return {
      totalContacts: contacts.length,
      newContacts: byStatus.new ?? 0,
      contacted: contactedOrMore,
      replied,
      replyRate: contactedOrMore ? replied / contactedOrMore : 0,
      emailsSent7d: emails.filter((e) => e.status === "sent").length,
      emailsFailed7d: emails.filter((e) => e.status === "failed").length,
      byStatus,
      last7Days: [...perDay.entries()].map(([day, count]) => ({ day, count })),
    };
  },
};
