import { describe, expect, it } from "vitest";
import { updateContactSchema } from "@/lib/validation/contact";
import { createSenderAccountSchema, updateSenderAccountSchema } from "@/lib/validation/outreach";

describe("sender account validation", () => {
  it("keeps create defaults for a new mailbox", () => {
    const parsed = createSenderAccountSchema.parse({
      label: "Gmail",
      fromEmail: "luan@example.com",
      smtpHost: "smtp.gmail.com",
      smtpPassword: "app-password",
    });
    expect(parsed.smtpPort).toBe(587);
    expect(parsed.smtpSecure).toBe(false);
    expect(parsed.dailyLimit).toBe(50);
    expect(parsed.isDefault).toBe(false);
  });

  it("does not reset SMTP settings when only the profile is patched", () => {
    const parsed = updateSenderAccountSchema.parse({
      roleTitle: "Senior Software Engineer",
      experienceSummary: "Built React and Node products.",
    });
    expect(parsed).toEqual({
      roleTitle: "Senior Software Engineer",
      experienceSummary: "Built React and Node products.",
    });
    expect(parsed).not.toHaveProperty("smtpPort");
    expect(parsed).not.toHaveProperty("smtpSecure");
    expect(parsed).not.toHaveProperty("dailyLimit");
    expect(parsed).not.toHaveProperty("isDefault");
  });
});

describe("contact PATCH validation", () => {
  it("leaves status, source and tags alone when only notes change", () => {
    expect(updateContactSchema.parse({ notes: "called twice" })).toEqual({
      notes: "called twice",
    });
  });
});