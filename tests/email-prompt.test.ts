import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPTS } from "@/server/services/prompts/proposal.prompt";
import { plainEmailText, sanitizeEmail } from "@/server/services/proposal-sanitize";

/** The email step has an exact, machine-readable contract. */
describe("email draft prompt", () => {
  const prompt = DEFAULT_PROMPTS.email_draft;
  const all = `${prompt.system}\n${prompt.user}`;

  it("asks for exactly the nested email object", () => {
    expect(all).toContain('{ "email": { "subject": string, "content": string } }');
    expect(all).not.toContain("similar_products");
  });

  it("covers requirements, the PPD approach and every question", () => {
    expect(prompt.system).toContain("REQUIREMENTS AND APPROACH");
    expect(prompt.system).toContain("Follow the reviewed PPD");
    expect(prompt.system).toContain("Answer EVERY question or direct request");
    expect(prompt.system).toContain("Use web search");
    expect(prompt.user).toContain("{{job_questions}}");
    expect(prompt.user).toContain("{{research_notes}}");
    expect(prompt.user).toContain("{{ppd_summary}}");
  });

  it("asks for a hands-on pitch with a bulleted list of verified links in [Label](URL) form", () => {
    expect(prompt.system).toContain("hands-on");
    expect(prompt.system).toContain("handover");
    expect(prompt.system).toContain("- [Feature workflow](https://example.com/feature)");
    expect(prompt.system).toContain("official Apple App Store / Google Play");
    expect(prompt.system).toContain("keep each list item on its own");
  });

  it("leaves the sign-off to the server", () => {
    expect(prompt.system).toContain("Do not write a sign-off");
    expect(prompt.user).toContain("Do not include {{whatsapp_share_link}}");
  });
});

/** Spam filters weigh plain text, so the email must stay plain ASCII with few links. */
describe("email spam safety", () => {
  it("tells the model to avoid dashes, curly quotes, bullet glyphs, emoji and exclamation marks", () => {
    const all = `${DEFAULT_PROMPTS.email_draft.system}\n${DEFAULT_PROMPTS.email_draft.user}`;
    expect(all).toContain("Never use em dashes, en dashes, curly quotes");
    expect(all).toContain("Never use exclamation marks");
    expect(all).toContain("at most 2 links");
  });

  it("converts typographic characters to plain ASCII and keeps letters", () => {
    const text = "Hi \u201cteam\u201d \u2014 the PDF\u2019s ready\u2026 \u2022 item \u2013 2\u20134 \ud83d\ude00 done!";
    expect(plainEmailText(text)).toBe(`Hi "team", the PDF's ready... item-2-4 done.`);
    expect(plainEmailText("Caf\u00e9 \u00a3 50")).toBe("Caf\u00e9 \u00a3 50");
  });

  it("keeps the exclamation mark inside a link URL", () => {
    expect(plainEmailText("See [Docs](https://example.com/a!b) now!")).toBe("See [Docs](https://example.com/a!b) now.");
  });

  it("keeps at most two body links and never emits a dash in the subject or body", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Routing \u2014 help",
          content: [
            "Hi Sam,",
            "",
            "I read your post \u2014 the queue is the hard part.",
            "",
            "- [Routing page](https://example.com/routing)",
            "- [Queue page](https://example.com/queue)",
            "- [Extra page](https://example.com/extra)",
            "",
            "Happy to talk!",
          ].join("\n"),
        },
      },
      { jobTitle: "Routing help", ppd: undefined as never },
    );
    expect(email.content.match(/\]\(https?:\/\//g)).toHaveLength(2);
    expect(email.content).toContain("Extra page");
    expect(email.content).not.toContain("example.com/extra");
    expect(email.content).not.toMatch(/[\u2012-\u2015\u201C-\u201F\u2018-\u201B]/);
    expect(email.subject).not.toMatch(/\u2014/);
  });
});

/** Links must be live work, and the email never says what the writer cannot show. */
describe("email research and gap rules", () => {
  const prompt = DEFAULT_PROMPTS.email_draft;
  const all = `${prompt.system}\n${prompt.user}`;
  const emailCtx = { jobTitle: "Phone build", ppd: undefined as never };

  it("asks for live apps, not overview or reference pages, and omits links silently", () => {
    expect(all).toContain("third-party live apps or production projects");
    expect(all).toContain("product overview, features, pricing");
    expect(all).toContain("omit every link and do not mention links or research");
    expect(all).toContain("Describe your own work, not the app's");
  });

  it("bans phrases about what the writer cannot show", () => {
    expect(all).toContain('"I cannot"');
    expect(all).toContain('"no verified"');
    expect(all).toContain("Never write about what you cannot show");
  });

  it("drops gap sentences from the email and keeps the rest", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Phone build",
          content: [
            "Hi Sam,",
            "",
            "I cannot provide substantiated telephone-system examples or verified experience with Twilio. I can build the call flow and handover.",
            "",
            "I have not worked with SIP phones yet. I will test them in week two.",
          ].join("\n"),
        },
      },
      emailCtx,
    );
    expect(email.content).not.toMatch(/cannot|have not|verified experience/i);
    expect(email.content).toContain("I can build the call flow and handover.");
    expect(email.content).toContain("I will test them in week two.");
  });

  it("drops a bullet that is itself a gap statement", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Phone build",
          content: "Hi Sam,\n\n- I cannot show a live SIP example.\n- [Call flow](https://example.com/app): live call flow\n\nThanks.",
        },
      },
      emailCtx,
    );
    expect(email.content).not.toContain("cannot show");
    expect(email.content).toContain("[Call flow](https://example.com/app)");
  });

  it("sends an email with no links instead of failing", () => {
    const email = sanitizeEmail({ email: { subject: "Phone build", content: "Hi Sam,\n\nI can build it in six weeks." } }, emailCtx);
    expect(email.content).toContain("I can build it in six weeks.");
  });

  it("strips overview and pricing pages, not just blogs", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Phone build",
          content: "Hi Sam,\n\n- [Voice](https://vendor.example.com/voice/features): overview\n- [Pricing](https://vendor.example.com/pricing): plans",
        },
      },
      emailCtx,
    );
    expect(email.content).not.toContain("vendor.example.com");
  });
});
