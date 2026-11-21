import { getAdminClient } from "@/lib/supabase/admin";
import type { EmailLogRow, Maybe, Paged } from "@/types/domain";
import { ApiError } from "@/server/http/errors";

const LOG_COLUMNS =
  "id,contact_id,to_email,from_email,subject,body_text,status,provider,provider_message_id,error,sent_at,created_at";

export interface ListEmailLogsQuery {
  page: number;
  pageSize: number;
  status?: string;
  to?: string;
}

export const emailLogsRepo = {
  async list(query: ListEmailLogsQuery): Promise<Paged<EmailLogRow>> {
    const supabase = getAdminClient();
    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;

    let builder = supabase
      .from("email_logs")
      .select(LOG_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (query.status) builder = builder.eq("status", query.status);
    if (query.to) builder = builder.ilike("to_email", `%${query.to}%`);

    const { data, error, count } = await builder;
    if (error) throw ApiError.upstream(`Failed to load email logs: ${error.message}`);

    const total = count ?? data?.length ?? 0;
    return {
      items: (data ?? []) as EmailLogRow[],
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  },

  async withContact(id: string) {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("email_logs")
      .select(`${LOG_COLUMNS}, contact:contacts(id,name,email,company,status)`)
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to load email log: ${error.message}`);
    return data as Maybe<EmailLogRow & { contact?: Record<string, unknown> }>;
  },
};
