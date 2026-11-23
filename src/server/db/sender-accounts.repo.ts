import { getAdminClient } from "@/lib/supabase/admin";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto";
import type { Database } from "@/types/database";
import type { SenderAccountRow } from "@/types/lead";
import { ApiError } from "@/server/http/errors";

export const SENDER_PUBLIC_COLUMNS =
  "id,label,from_email,display_name,reply_to,signature,smtp_host,smtp_port,smtp_secure,smtp_user,daily_limit,sent_count,status,is_default,last_verified_at,last_error,created_at,updated_at";

export interface SenderAccountDto {
  id: string;
  label: string;
  from_email: string;
  display_name: string | null;
  reply_to: string | null;
  signature: string | null;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  smtp_user: string | null;
  has_password: boolean;
  password_mask: string | null;
  daily_limit: number;
  sent_count: number;
  status: string;
  is_default: boolean;
  last_verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SmtpCredentials {
  id: string;
  label: string;
  from: string;
  replyTo: string | null;
  signature: string | null;
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
}

export interface UpsertSenderInput {
  label: string;
  fromEmail: string;
  displayName?: string | null;
  replyTo?: string | null;
  signature?: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser?: string | null;
  smtpPassword?: string | null;
  dailyLimit?: number;
  isDefault?: boolean;
}

export const senderAccountsRepo = {
  async list(): Promise<SenderAccountDto[]> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("sender_accounts")
      .select(SENDER_PUBLIC_COLUMNS)
      .order("is_default", { ascending: false })
      .order("label");
    if (error) throw ApiError.upstream(`Failed to load sender accounts: ${error.message}`);
    return (data ?? []).map(toDto);
  },

  async getPublic(id: string): Promise<SenderAccountDto> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("sender_accounts")
      .select(SENDER_PUBLIC_COLUMNS)
      .eq("id", id)
      .maybeSingle();
    if (error) throw ApiError.upstream(`Failed to load sender account: ${error.message}`);
    if (!data) throw ApiError.notFound("Sender account not found");
    return toDto(data as Omit<SenderAccountRow, "smtp_password_cipher">);
  },

  async create(input: UpsertSenderInput): Promise<SenderAccountDto> {
    const supabase = getAdminClient();

    if (input.isDefault) await clearDefault(supabase);

    const { data, error } = await supabase
      .from("sender_accounts")
      .insert({
        label: input.label,
        from_email: input.fromEmail.toLowerCase(),
        display_name: input.displayName ?? null,
        reply_to: input.replyTo?.toLowerCase() ?? null,
        signature: input.signature ?? null,
        smtp_host: input.smtpHost,
        smtp_port: input.smtpPort,
        smtp_secure: input.smtpSecure,
        smtp_user: input.smtpUser ?? input.fromEmail.toLowerCase(),
        smtp_password_cipher: input.smtpPassword ? encryptSecret(input.smtpPassword) : null,
        daily_limit: input.dailyLimit ?? 50,
        is_default: input.isDefault ?? false,
      })
      .select(SENDER_PUBLIC_COLUMNS)
      .single();

    if (error) {
      if (error.code === "23505") {
        throw ApiError.conflict(`${input.fromEmail} is already configured`);
      }
      throw ApiError.upstream(`Failed to create sender account: ${error.message}`);
    }
    return toDto(data as Omit<SenderAccountRow, "smtp_password_cipher">);
  },

  /** `smtpPassword` omitted or blank keeps the existing secret untouched. */
  async update(id: string, input: Partial<UpsertSenderInput>): Promise<SenderAccountDto> {
    const supabase = getAdminClient();
    const patch: Database["public"]["Tables"]["sender_accounts"]["Update"] = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.fromEmail !== undefined) patch.from_email = input.fromEmail.toLowerCase();
    if (input.displayName !== undefined) patch.display_name = input.displayName;
    if (input.replyTo !== undefined) patch.reply_to = input.replyTo?.toLowerCase() ?? null;
    if (input.signature !== undefined) patch.signature = input.signature;
    if (input.smtpHost !== undefined) patch.smtp_host = input.smtpHost;
    if (input.smtpPort !== undefined) patch.smtp_port = input.smtpPort;
    if (input.smtpSecure !== undefined) patch.smtp_secure = input.smtpSecure;
    if (input.smtpUser !== undefined) patch.smtp_user = input.smtpUser;
    if (input.dailyLimit !== undefined) patch.daily_limit = input.dailyLimit;
    if (input.smtpPassword) {
      patch.smtp_password_cipher = encryptSecret(input.smtpPassword);
    }
    if (input.isDefault) {
      patch.is_default = true;
      await clearDefault(supabase);
    }

    const { data, error } = await supabase
      .from("sender_accounts")
      .update(patch)
      .eq("id", id)
      .select(SENDER_PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to update sender account: ${error.message}`);
    if (!data) throw ApiError.notFound("Sender account not found");
    return toDto(data as Omit<SenderAccountRow, "smtp_password_cipher">);
  },

  async remove(id: string) {
    const supabase = getAdminClient();
    const { error, count } = await supabase
      .from("sender_accounts")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) throw ApiError.upstream(`Failed to delete sender account: ${error.message}`);
    if (!count) throw ApiError.notFound("Sender account not found");
  },

  async markVerified(id: string, okFlag: boolean, message?: string) {
    const supabase = getAdminClient();
    await supabase
      .from("sender_accounts")
      .update({
        status: okFlag ? "active" : "error",
        last_verified_at: okFlag ? new Date().toISOString() : null,
        last_error: okFlag ? null : (message ?? "SMTP verification failed").slice(0, 500),
      })
      .eq("id", id);
  },

  /** Read-modify-write: good enough for a few hundred sends/day. */
  async incrementSent(id: string) {
    const supabase = getAdminClient();
    const { data } = await supabase
      .from("sender_accounts")
      .select("sent_count")
      .eq("id", id)
      .maybeSingle();
    const next = ((data as { sent_count?: number } | null)?.sent_count ?? 0) + 1;
    const { error } = await supabase
      .from("sender_accounts")
      .update({ sent_count: next })
      .eq("id", id);
    if (error) {
      const { logger } = await import("@/lib/logger");
      logger.warn("sender_sent_count_update_failed", { id, error: error.message });
    }
  },

  /** Full decrypted credentials — used only inside `server/services/smtp*`. */
  async credentials(id: string): Promise<SmtpCredentials> {
    const supabase = getAdminClient();
    const { data, error } = await supabase
      .from("sender_accounts")
      .select("id,label,from_email,display_name,reply_to,signature,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password_cipher,status")
      .eq("id", id)
      .maybeSingle();

    if (error) throw ApiError.upstream(`Failed to load sender credentials: ${error.message}`);
    if (!data) throw ApiError.notFound(`Sender account ${id} not found`);
    if (data.status !== "active") {
      throw ApiError.forbidden(`Sender account ${data.label} is ${data.status}`);
    }

    let password: string | null = null;
    if (data.smtp_password_cipher) {
      try {
        password = decryptSecret(data.smtp_password_cipher);
      } catch {
        throw ApiError.internal(
          "Could not decrypt this SMTP password — APP_ENCRYPTION_KEY changed.",
        );
      }
    }

    const from = data.display_name
      ? `"${data.display_name}" <${data.from_email}>`
      : data.from_email;

    return {
      id: data.id,
      label: data.label,
      from,
      replyTo: data.reply_to,
      signature: data.signature,
      host: data.smtp_host,
      port: data.smtp_port,
      secure: data.smtp_secure,
      user: data.smtp_user,
      password,
    };
  },

  async defaultAccountId(): Promise<string | null> {
    const supabase = getAdminClient();
    const { data } = await supabase
      .from("sender_accounts")
      .select("id")
      .eq("is_default", true)
      .eq("status", "active")
      .limit(1);
    if (data?.[0]?.id) return data[0].id as string;

    const { data: anyActive } = await supabase
      .from("sender_accounts")
      .select("id")
      .eq("status", "active")
      .order("created_at")
      .limit(1);
    return anyActive?.[0]?.id ?? null;
  },
};

async function clearDefault(supabase: ReturnType<typeof getAdminClient>) {
  await supabase
    .from("sender_accounts")
    .update({ is_default: false })
    .eq("is_default", true);
}

type PublicSenderRow = Omit<SenderAccountRow, "smtp_password_cipher"> & {
  smtp_password_cipher?: string | null;
};

function toDto(row: PublicSenderRow): SenderAccountDto {
  const { smtp_password_cipher: _cipher, ...rest } = row as SenderAccountRow;
  return {
    ...rest,
    has_password: Boolean(row.smtp_password_cipher),
    password_mask: maskSecret(row.smtp_password_cipher ?? undefined),
  } as SenderAccountDto;
}
