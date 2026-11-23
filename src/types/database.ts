/**
 * Hand-written stand-in for `supabase gen types typescript`.
 * Regenerate after schema changes:  `npm run db:types`
 * Mirrors supabase/migrations/0001_init.sql + 0002_leads_senders_proposals.sql.
 *
 * Insert/Update are written FLAT (no `Partial<X> & {...}` intersections): the
 * postgrest-js type helpers only infer column types correctly for plain object
 * types, otherwise every `.insert()/.update()` collapses to `never`.
 */
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ContactStatus = "new" | "contacted" | "replied" | "no_reply" | "archived";
export type EmailLogStatus = "queued" | "sent" | "failed" | "bounced";
export type LeadConfidence = "HIGH" | "MEDIUM" | "LOW" | "UNIDENTIFIED";
export type LeadStatus =
  | "received"
  | "enriched"
  | "proposal_ready"
  | "draft_created"
  | "sent"
  | "failed"
  | "archived";
export type ContactList =
  | "verified"
  | "potential"
  | "company_page"
  | "linkedin"
  | "social"
  | "key_person";
export type ChannelKind = "email" | "phone" | "url" | "other";
export type SenderStatus = "active" | "paused" | "error";
export type DraftStatus = "draft" | "queued" | "sent" | "failed" | "cancelled";

type NoMatch = { [_ in never]: never };

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
          draft_id: string | null;
          proposal_id: string | null;
          sender_account_id: string | null;
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
          draft_id?: string | null;
          proposal_id?: string | null;
          sender_account_id?: string | null;
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
          contact_id?: string | null;
          draft_id?: string | null;
          proposal_id?: string | null;
          sender_account_id?: string | null;
          to_email?: string;
          from_email?: string;
          subject?: string;
          body_text?: string;
          status?: EmailLogStatus;
          provider?: string;
          provider_message_id?: string | null;
          error?: string | null;
          sent_at?: string | null;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "email_logs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_draft_id_fkey";
            columns: ["draft_id"];
            isOneToOne: false;
            referencedRelation: "email_drafts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "proposals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_sender_account_id_fkey";
            columns: ["sender_account_id"];
            isOneToOne: false;
            referencedRelation: "sender_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
      sender_accounts: {
        Row: {
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
          smtp_password_cipher: string | null;
          daily_limit: number;
          sent_count: number;
          status: SenderStatus;
          is_default: boolean;
          last_verified_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          label: string;
          from_email: string;
          display_name?: string | null;
          reply_to?: string | null;
          signature?: string | null;
          smtp_host: string;
          smtp_port?: number;
          smtp_secure?: boolean;
          smtp_user?: string | null;
          smtp_password_cipher?: string | null;
          daily_limit?: number;
          sent_count?: number;
          status?: SenderStatus;
          is_default?: boolean;
          last_verified_at?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          label?: string;
          from_email?: string;
          display_name?: string | null;
          reply_to?: string | null;
          signature?: string | null;
          smtp_host?: string;
          smtp_port?: number;
          smtp_secure?: boolean;
          smtp_user?: string | null;
          smtp_password_cipher?: string | null;
          daily_limit?: number;
          sent_count?: number;
          status?: SenderStatus;
          is_default?: boolean;
          last_verified_at?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      leads: {
        Row: {
          id: string;
          dedupe_key: string;
          job_id: string | null;
          job_title: string | null;
          job_url: string | null;
          job_location: string | null;
          industry: string | null;
          company_mentioned: string | null;
          client_name: string | null;
          client_location: string | null;
          job_description: string | null;
          overall_confidence: LeadConfidence;
          key_people: Json;
          contact_information: Json;
          raw_payload: Json;
          status: LeadStatus;
          error: string | null;
          received_at: string;
          created_at: string;
          updated_at: string;
          search: string | null;
        };
        Insert: {
          id?: string;
          dedupe_key: string;
          job_id?: string | null;
          job_title?: string | null;
          job_url?: string | null;
          job_location?: string | null;
          industry?: string | null;
          company_mentioned?: string | null;
          client_name?: string | null;
          client_location?: string | null;
          job_description?: string | null;
          overall_confidence?: LeadConfidence;
          key_people?: Json;
          contact_information?: Json;
          raw_payload: Json;
          status?: LeadStatus;
          error?: string | null;
          received_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          dedupe_key?: string;
          job_id?: string | null;
          job_title?: string | null;
          job_url?: string | null;
          job_location?: string | null;
          industry?: string | null;
          company_mentioned?: string | null;
          client_name?: string | null;
          client_location?: string | null;
          job_description?: string | null;
          overall_confidence?: LeadConfidence;
          key_people?: Json;
          contact_information?: Json;
          raw_payload?: Json;
          status?: LeadStatus;
          error?: string | null;
          received_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lead_contacts: {
        Row: {
          id: string;
          lead_id: string;
          list_type: ContactList;
          name: string | null;
          role: string | null;
          company: string | null;
          contact_type: string | null;
          channel: ChannelKind;
          contact_value: string;
          normalized_value: string | null;
          confidence: LeadConfidence | null;
          rationale: string | null;
          source_url: string | null;
          is_email: boolean;
          is_primary: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          list_type: ContactList;
          name?: string | null;
          role?: string | null;
          company?: string | null;
          contact_type?: string | null;
          channel?: ChannelKind;
          contact_value: string;
          normalized_value?: string | null;
          confidence?: LeadConfidence | null;
          rationale?: string | null;
          source_url?: string | null;
          is_email?: boolean;
          is_primary?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          lead_id?: string;
          list_type?: ContactList;
          name?: string | null;
          role?: string | null;
          company?: string | null;
          contact_type?: string | null;
          channel?: ChannelKind;
          contact_value?: string;
          normalized_value?: string | null;
          confidence?: LeadConfidence | null;
          rationale?: string | null;
          source_url?: string | null;
          is_email?: boolean;
          is_primary?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "lead_contacts_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
        ];
      };
      proposals: {
        Row: {
          id: string;
          lead_id: string;
          lead_contact_id: string | null;
          version: number;
          provider: string;
          model: string | null;
          ppd: Json;
          email_subject: string;
          email_content: string;
          email_html: string | null;
          pdf_path: string | null;
          pdf_status: string;
          prompt_tokens: number | null;
          completion_tokens: number | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          lead_contact_id?: string | null;
          version?: number;
          provider?: string;
          model?: string | null;
          ppd: Json;
          email_subject: string;
          email_content: string;
          email_html?: string | null;
          pdf_path?: string | null;
          pdf_status?: string;
          prompt_tokens?: number | null;
          completion_tokens?: number | null;
          error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          lead_id?: string;
          lead_contact_id?: string | null;
          version?: number;
          provider?: string;
          model?: string | null;
          ppd?: Json;
          email_subject?: string;
          email_content?: string;
          email_html?: string | null;
          pdf_path?: string | null;
          pdf_status?: string;
          prompt_tokens?: number | null;
          completion_tokens?: number | null;
          error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "proposals_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "proposals_lead_contact_id_fkey";
            columns: ["lead_contact_id"];
            isOneToOne: false;
            referencedRelation: "lead_contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      email_drafts: {
        Row: {
          id: string;
          lead_id: string;
          lead_contact_id: string | null;
          proposal_id: string | null;
          sender_account_id: string | null;
          to_email: string;
          cc: Json;
          subject: string;
          body_text: string;
          body_html: string | null;
          attachments: Json;
          status: DraftStatus;
          scheduled_at: string | null;
          sent_at: string | null;
          error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          lead_id: string;
          lead_contact_id?: string | null;
          proposal_id?: string | null;
          sender_account_id?: string | null;
          to_email: string;
          cc?: Json;
          subject: string;
          body_text: string;
          body_html?: string | null;
          attachments?: Json;
          status?: DraftStatus;
          scheduled_at?: string | null;
          sent_at?: string | null;
          error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          lead_id?: string;
          lead_contact_id?: string | null;
          proposal_id?: string | null;
          sender_account_id?: string | null;
          to_email?: string;
          cc?: Json;
          subject?: string;
          body_text?: string;
          body_html?: string | null;
          attachments?: Json;
          status?: DraftStatus;
          scheduled_at?: string | null;
          sent_at?: string | null;
          error?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_drafts_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_drafts_lead_contact_id_fkey";
            columns: ["lead_contact_id"];
            isOneToOne: false;
            referencedRelation: "lead_contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_drafts_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "proposals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_drafts_sender_account_id_fkey";
            columns: ["sender_account_id"];
            isOneToOne: false;
            referencedRelation: "sender_accounts";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      /** public.contact_funnel (0001) */
      contact_funnel: {
        Row: {
          status: ContactStatus;
          contacts: number;
          touched: number;
          last_touch_at: string | null;
        };
        Relationships: [];
      };
      /** public.lead_pipeline (0002) */
      lead_pipeline: {
        Row: {
          id: string;
          job_title: string | null;
          company_mentioned: string | null;
          client_name: string | null;
          overall_confidence: LeadConfidence;
          status: LeadStatus;
          received_at: string;
          email_contacts: number | null;
          proposals: number | null;
          sent: number | null;
          drafts: number | null;
        };
        Relationships: [];
      };
    };
    Functions: NoMatch;
    Enums: {
      contact_status: ContactStatus;
      email_log_status: EmailLogStatus;
      lead_confidence: LeadConfidence;
      lead_status: LeadStatus;
      contact_list: ContactList;
      channel_kind: ChannelKind;
      sender_status: SenderStatus;
      draft_status: DraftStatus;
    };
    CompositeTypes: NoMatch;
  };
}
