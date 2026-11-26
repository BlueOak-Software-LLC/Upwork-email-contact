import { describe, expect, it } from "vitest";
import { emailSignatureLines } from "@/lib/email-signature";
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

describe("canonical email signature", () => {
  it("uses the requested four-line format with one linked website and no sender mailbox", () => {
    expect(emailSignatureLines({
      name: "Luan Le",
      role: "Senior Software Engineer",
      company: "Luan Labs",
      website: "https://luanle.dev/",
    })).toEqual([
      "Best Regards,",
      "Luan Le",
      "WhatsApp: [Start chatting](https://wa.me/84366425800)",
      "Senior Software Engineer | [Luan Labs](https://luanle.dev)",
    ]);
  });

  it("validates a website before including it in the linked company line", () => {
    expect(emailSignatureLines({
      name: "Luan Le",
      role: "Engineer",
      company: "Luan Labs",
      website: "javascript:alert(1)",
    })).toEqual([
      "Best Regards,",
      "Luan Le",
      "WhatsApp: [Start chatting](https://wa.me/84366425800)",
      "Engineer | Luan Labs",
    ]);
  });
});

describe("contact PATCH validation", () => {
  it("leaves status, source and tags alone when only notes change", () => {
    expect(updateContactSchema.parse({ notes: "called twice" })).toEqual({
      notes: "called twice",
    });
  });
});