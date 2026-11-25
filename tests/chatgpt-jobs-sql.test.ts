import { type PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, createTestDb } from "./helpers/db";

/**
 * 0008 adds the durable ChatGPT-session hand-off and multi-touch drafts; 0009
 * adds the `completing` claim state. The partial unique index is the important
 * part: two live PPD jobs on one lead must be impossible, while a finished job
 * must not block the next version.
 */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

async function lead(title: string) {
  const { rows } = await asService<{ id: string }>(
    db,
    `insert into public.leads (dedupe_key, job_title, status, raw_payload)
     values ($1, $2, 'received'::public.lead_status, '{}'::jsonb) returning id`,
    [title, title],
  );
  return rows[0]!.id;
}

async function job(leadId: string, kind: string, status = "queued") {
  const { rows } = await asService<{ id: string }>(
    db,
    `insert into public.chatgpt_jobs
       (lead_id, kind, status, prompt_key, prompt_label, prompt_system, prompt_user, context)
     values ($1, $2, $3, $2, $2, 'system', 'user', '{"kind":"ppd_document"}'::jsonb)
     returning id`,
    [leadId, kind, status],
  );
  return rows[0]!.id;
}

describe("0008/0009 chatgpt jobs", () => {
  it("allows one live job per kind and frees the slot when it ends", async () => {
    const leadId = await lead("ChatGPT concurrency");
    const first = await job(leadId, "ppd_document");

    await expect(job(leadId, "ppd_document")).rejects.toThrow();
    // A different kind is a different slot.
    await expect(job(leadId, "email_draft")).resolves.toBeTruthy();

    await asService(db, `update public.chatgpt_jobs set status = 'cancelled' where id = $1`, [first]);
    await expect(job(leadId, "ppd_document")).resolves.toBeTruthy();
  });

  it("lets exactly one request claim completion and keeps the live slot occupied", async () => {
    const leadId = await lead("Completion claim");
    const id = await job(leadId, "ppd_document");

    const first = await asService<{ id: string }>(
      db,
      `update public.chatgpt_jobs set status = 'completing', response_text = 'answer'
       where id = $1 and status in ('queued', 'running') and response_text is null
       returning id`,
      [id],
    );
    expect(first.rows).toHaveLength(1);

    const second = await asService<{ id: string }>(
      db,
      `update public.chatgpt_jobs set status = 'completing', response_text = 'answer'
       where id = $1 and status in ('queued', 'running') and response_text is null
       returning id`,
      [id],
    );
    expect(second.rows).toHaveLength(0);

    // `completing` still holds the live slot, so no second PPD can start.
    await expect(job(leadId, "ppd_document")).rejects.toThrow();

    await asService(db, `update public.chatgpt_jobs set status = 'completed' where id = $1`, [id]);
    await expect(job(leadId, "ppd_document")).resolves.toBeTruthy();
  });

  it("stores follow-up sequence, parent and purpose on a draft", async () => {
    const leadId = await lead("Follow-up rows");
    const { rows: parentRows } = await asService<{ id: string }>(
      db,
      `insert into public.email_drafts (lead_id, to_email, subject, body_text, status, sequence, purpose)
       values ($1, 'client@example.com', 'Hello', 'first', 'sent'::public.draft_status, 1, 'initial')
       returning id`,
      [leadId],
    );
    const parent = parentRows[0]!.id;
    const { rows } = await asService<{
      sequence: number;
      parent_draft_id: string;
      purpose: string;
    }>(
      db,
      `insert into public.email_drafts
         (lead_id, to_email, subject, body_text, sequence, parent_draft_id, purpose)
       values ($1, 'client@example.com', 'Re: Hello', 'second', 2, $2, 'follow_up')
       returning sequence, parent_draft_id, purpose`,
      [leadId, parent],
    );
    expect(rows[0]).toEqual({ sequence: 2, parent_draft_id: parent, purpose: "follow_up" });
  });

  it("accepts a follow_up prompt key and still rejects an unknown key", async () => {
    await expect(
      asService(
        db,
        `insert into public.prompt_templates (key, label, system_text, user_template)
         values ('follow_up', 'Follow-up', 'system', 'user')`,
      ),
    ).resolves.toBeTruthy();
    await expect(
      asService(
        db,
        `insert into public.prompt_templates (key, label, system_text, user_template)
         values ('not_a_prompt', 'Nope', 'system', 'user')`,
      ),
    ).rejects.toThrow();
  });

  it("retires the old model-API table and defaults to chatgpt-session", async () => {
    const { rows: table } = await asService<{ name: string | null }>(
      db,
      `select to_regclass('public.ai_settings')::text as name`,
    );
    expect(table[0]?.name).toBeNull();

    const { rows: column } = await asService<{ column_default: string | null }>(
      db,
      `select column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'proposals' and column_name = 'provider'`,
    );
    expect(column[0]?.column_default).toContain("chatgpt-session");
  });
});
