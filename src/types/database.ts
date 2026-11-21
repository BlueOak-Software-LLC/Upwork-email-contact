/**
 * Hand-written stand-in for `supabase gen types typescript`.
 * Run `npm run db:types` after applying migrations to overwrite this file with
 * the generated version — the shapes below mirror supabase/migrations/0001_init.sql.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ContactStatus =
  | "new"
  | "contacted"
  | "replied"
  | "no_reply"
  | "archived";

export type EmailLogStatus = "queued" | "sent" | "failed" | "bounced";

export interface Database {
  public: {
    Tables: {
      contacts: {
        Row: {
          id: string;
          name: string;
          email: string;
          company: string | null;
          role: string | null;
          status: ContactStatus;
          source: string;
          tags: string[];
          notes: string | null;
          last_contacted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          name: string;
          email: string;
          company?: string | null;
          role?: string | null;
          status?: ContactStatus;
          source?: string;
          tags?: string[];
          notes?: string | null;
          last_contacted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          email?: string;
          company?: string | null;
          role?: string | null;
          status?: ContactStatus;
          source?: string;
          tags?: string[];
          notes?: string | null;
          last_contacted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      email_logs: {
        Row: {
          id: string;
          contact_id: string | null;
          to_email: string;
          from_email: string;
          subject: string;
          body_text: string;
          status: EmailLogStatus;
          provider: string;
          provider_message_id: string | null;
          error: string | null;
          sent_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          contact_id?: string | null;
          to_email: string;
          from_email: string;
          subject: string;
          body_text?: string;
          status?: EmailLogStatus;
          provider?: string;
          provider_message_id?: string | null;
          error?: string | null;
          sent_at?: string | null;
          created_at?: string;
        };
        Update: {
          status?: EmailLogStatus;
          provider_message_id?: string | null;
          error?: string | null;
          sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_logs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: {
      contact_status: ContactStatus;
      email_log_status: EmailLogStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
}
