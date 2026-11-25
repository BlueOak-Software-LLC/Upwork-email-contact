import { type PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, createTestDb } from "./helpers/db";

/** 0010 adds the public sender profile the PPD and email sign-off are built from. */

let db: PGlite;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

describe("0010 sender profile", () => {
  it("stores the profile fields without touching the SMTP secret", async () => {
    const { rows } = await asService<{
      display_name: string;
      role_title: string;
      phone: string;
      whatsapp: string;
      linkedin_url: string;
      website: string;
      location: string;
      experience_summary: string;
      skills: string;
    }>(
      db,
      `insert into public.sender_accounts
         (label, from_email, display_name, role_title, phone, whatsapp, linkedin_url,
          website, location, experience_summary, skills, smtp_host, smtp_port, is_default)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 465, true)
       returning display_name, role_title, phone, whatsapp, linkedin_url, website,
                 location, experience_summary, skills`,
      [
        "Luan — Gmail",
        "luan@example.com",
        "Luan Le",
        "Senior Software Engineer",
        "+84 90 123 4567",
        "https://wa.me/84901234567",
        "https://www.linkedin.com/in/luanle",
        "https://luanle.dev",
        "Ho Chi Minh City, GMT+7",
        "Built React and Node products for 10 years.",
        "React, TypeScript, Supabase",
        "smtp.gmail.com",
      ],
    );
    expect(rows[0]).toMatchObject({
      display_name: "Luan Le",
      role_title: "Senior Software Engineer",
      website: "https://luanle.dev",
      experience_summary: "Built React and Node products for 10 years.",
    });
  });
});