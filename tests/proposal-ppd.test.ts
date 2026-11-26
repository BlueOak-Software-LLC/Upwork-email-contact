import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "@pdfme/pdf-lib";
import { generate } from "@pdfme/generator";
import { line, rectangle, text } from "@pdfme/schemas";
import { compileProposalPdfme } from "@/lib/pdfme/compiler";
import {
  DEFAULT_PPD_CLOSING,
  DOC_WORD_TARGET,
  assertPpdShape,
  sanitizeEmail,
  sanitizePpd,
  type ProposalContext,
} from "@/server/services/proposal-sanitize";
import { extractQuestions } from "@/server/services/prompts/proposal.prompt";
import { htmlToText, textToHtml } from "@/server/services/templates";
import type { ProposalPpd } from "@/types/lead";

const fontPath = (name: string) =>
  fileURLToPath(new URL(`../public/fonts/${name}`, import.meta.url));

function context(overrides: Partial<ProposalContext> = {}): ProposalContext {
  return {
    preparedBy: "Luan Le",
    preparedRole: "Senior Software Engineer",
    senderEmail: "luan@example.com",
    senderPhone: "+84 90 123 4567",
    senderWhatsapp: "https://wa.me/84901234567",
    senderLinkedin: "https://www.linkedin.com/in/luanle",
    website: "https://luanle.dev",
    senderLocation: "Ho Chi Minh City, GMT+7",
    date: "25 November 2026",
    validUntil: "9 December 2026",
    rate: "USD 4,800–6,200, indicative",
    jobTitle: "Support workflow",
    jobReference: "~01abc",
    recipientName: "Hiring team",
    recipientCompany: "Northstar",
    clientName: "Northstar",
    today: "2026-11-25",
    verifiedReferences: [],
    ...overrides,
  };
}

function rawPpd(): Record<string, unknown> {
  return {
    document_title: "Customer support workflow proposal",
    subtitle: "A practical plan for routing and CRM sync.",
    prepared_for: "Hiring team · Northstar",
    rate: "USD 1",
    company: "Secret Agency LLC",
    prepared_by: "Invented Person",
    website: "https://secret-agency.example",
    sections: [
      {
        id: "understanding",
        title: "Project understanding",
        blocks: [{ type: "paragraph", items: ["The queue is manual and slow."] }],
      },
      {
        id: "approach",
        title: "Proposed approach",
        blocks: [{ type: "bullets", items: ["Map the queue", "Design the contract"] }],
      },
    ],
    closing: "Thank you. At [COMPANY], we deliver.",
  };
}

describe("sanitizePpd · sender identity", () => {
  it("stamps the selected sender profile and never prints a company", () => {
    const ppd = sanitizePpd(rawPpd(), context());
    expect(ppd.prepared_by).toBe("Luan Le");
    expect(ppd.prepared_role).toBe("Senior Software Engineer");
    expect(ppd.sender_email).toBe("luan@example.com");
    expect(ppd.sender_phone).toBe("+84 90 123 4567");
    expect(ppd.sender_whatsapp).toContain("wa.me");
    expect(ppd.sender_linkedin).toContain("linkedin.com");
    expect(ppd.sender_website).toBe("https://luanle.dev");
    expect(ppd.sender_location).toContain("Ho Chi Minh");
    expect(ppd.date).toBe("25 November 2026");
    expect(ppd.valid_until).toBe("9 December 2026");
    expect(ppd.rate).toBe("USD 4,800–6,200, indicative");
    expect(JSON.stringify(ppd)).not.toContain("Secret Agency");
    expect(JSON.stringify(ppd)).not.toContain("Invented Person");
    expect(JSON.stringify(ppd)).not.toContain("our studio");
    expect(ppd.closing).toBe(DEFAULT_PPD_CLOSING);
  });

  it("caps runaway sections before layout", () => {
    expect(DOC_WORD_TARGET.max).toBeLessThanOrEqual(900);
    const sections = Array.from({ length: 8 }, (_, index) => ({
      id: `section-${index}`,
      title: `Section ${index + 1}`,
      blocks: [
        {
          type: "paragraph",
          items: [
            "This paragraph explains the work in plain English and names the deliverables, the sequence and the acceptance criteria. ".repeat(8),
          ],
        },
      ],
    }));
    const ppd = sanitizePpd({ sections, closing: "Thank you." }, context());
    expect(ppd.sections.length).toBeLessThanOrEqual(6);
  });
});

describe("sanitizeEmail · product links", () => {
  const emailContext = {
    jobTitle: "Support workflow",
    sender: {
      preparedBy: "Luan Le",
      title: "Senior Software Engineer",
      senderEmail: "luan@example.com",
      website: "https://luanle.dev",
      company: "Luan Labs",
    },
    signature: [
      "Best Regards,",
      "Luan Le",
      "WhatsApp: [Start chatting](https://wa.me/84366425800)",
      "Senior Software Engineer | [Luan Labs](https://luanle.dev)",
    ],
    includeWhatsappContact: true,
  };

  it("removes blogs, review sites and affiliate URLs, keeping official product links", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content:
            "Hi team,\n\nI built a similar routing layer. See https://medium.com/@x/blog-post and https://www.g2.com/products/linear/reviews. Linear (https://linear.app) fits the queue.",
          similar_products: [
            { name: "Linear", url: "https://linear.app", why: "Issue tracking" },
            { name: "G2 list", url: "https://www.g2.com/products/linear/reviews", why: "Reviews" },
          ],
        },
      },
      emailContext,
    );
    expect(email.content).toContain("https://linear.app");
    expect(email.content).toContain("[https://linear.app](https://linear.app)");
    expect(email.content).not.toContain("medium.com");
    expect(email.content).not.toContain("g2.com");
    expect(email).not.toHaveProperty("similarProducts");
  });

  it("preserves bold and inline product links, and adds the requested WhatsApp contact", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content: "Hi team,\n\n**Approach:** See [Linear](https://linear.app) for the queue pattern.\n\nLet's discuss.",
        },
      },
      emailContext,
    );
    expect(email.content).toContain("**Approach:**");
    expect(email.content).toContain("[Linear](https://linear.app)");
    expect(email.content).toContain("https://wa.me/84366425800");
  });

  it("keeps a bulleted link list as list items and shows each URL once in HTML and text", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content: [
            "Hi team,",
            "",
            "Live examples for context:",
            "- [https://linear.app](https://linear.app) — queue triage",
            "- https://developers.notion.com/ — database views",
            "",
            "I would map the intake rules first and hand over the runbook at the end.",
          ].join("\n"),
        },
      },
      emailContext,
    );
    expect(email.content).toContain("- [https://linear.app](https://linear.app)");
    expect(email.content).toContain("- [https://developers.notion.com/](https://developers.notion.com/)");

    const html = textToHtml(email.content);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html.match(/https:\/\/linear\.app/g)).toHaveLength(2); // href + visible text only
    expect(html).not.toMatch(/<\/a>\s*https?:\/\//);
    const text = htmlToText(html);
    expect(text.match(/https:\/\/linear\.app/g)).toHaveLength(1);
    expect(text).toContain("- https://linear.app");
  });

  it("keeps paragraphs readable and replaces model closings/contact details with one canonical signature", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content: [
            "Hi team,",
            "",
            "Your triage queue needs a clear owner and reliable routing. I would map the intake rules first.",
            "",
            "Then I would build the workflow in stages and validate the handoffs with your team.",
            "",
            "The reviewed proposal is attached as a PDF. Are you available for a short call?",
            "",
            "Best regards,",
            "Luan Le",
            "luan@example.com",
          ].join("\n"),
        },
      },
      emailContext,
    );
    expect(email.content).toContain("Hi team,\n\n");
    expect(email.content).toContain("rules first.\n\nThen I would");
    expect(email.content).toContain("team.\n\nThe reviewed proposal");
    expect(email.content).not.toContain("luan@example.com");
    expect(email.content.match(/Best Regards,/g)).toHaveLength(1);
    expect(email.content).toContain("WhatsApp: [Start chatting](https://wa.me/84366425800)");
    expect(email.content).toContain("Senior Software Engineer | [Luan Labs](https://luanle.dev)");
    expect(email.content).not.toContain("luan@example.com");
    expect(email.content.match(/Best Regards,/g)).toHaveLength(1);
  });

  it("keeps an allowed reference link inline and returns exactly subject/content", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content:
            "Hi team,\n\nI built a similar routing layer. Linear (https://linear.app) shows the queue pattern I would apply.",
        },
      },
      emailContext,
    );
    expect(email.content).toContain("https://linear.app");
    expect(email.content).toContain("https://wa.me/84366425800");
    expect(Object.keys(email).sort()).toEqual(["content", "subject"]);
  });

  it("rejects source code, documentation and article destinations", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content: "See [source](https://github.com/acme/project) or [docs](https://docs.linear.app/api), plus https://linear.app/blog/update.",
        },
      },
      emailContext,
    );
    expect(email.content).not.toContain("github.com");
    expect(email.content).not.toContain("docs.linear.app");
    expect(email.content).not.toContain("linear.app/blog");
    expect(email.content).toContain("https://wa.me/84366425800");
  });

  it("does not start a fresh email subject with Re:", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Re: Support routing",
          content: "Hi team,\n\nI built a similar routing layer and would share the plan on a call.",
        },
      },
      emailContext,
    );
    expect(email.subject).toBe("Support routing");
  });

  it("does not append the legacy similar_products field to the email", () => {
    const email = sanitizeEmail(
      {
        email: {
          subject: "Support routing",
          content: "Hi team,\n\nI built a similar routing layer and would share the plan on a call.",
          similar_products: [
            { name: "Linear", url: "https://linear.app", why: "Issue tracking for support" },
          ],
        },
      },
      emailContext,
    );
    expect(email.content).not.toContain("https://linear.app");
    expect(email).not.toHaveProperty("similarProducts");
  });
});

describe("extractQuestions", () => {
  it("finds direct questions and answers them in order", () => {
    expect(
      extractQuestions("Can you start Monday? Do you have React experience?\nWhat is your rate?"),
    ).toEqual([
      "Can you start Monday?",
      "Do you have React experience?",
      "What is your rate?",
    ]);
  });

  it("keeps more than eight questions and accepts a quoted one", () => {
    const post = Array.from({ length: 10 }, (_, index) => `Question ${index + 1}?`).join("\n");
    expect(extractQuestions(post)).toHaveLength(10);
    expect(extractQuestions('"Can you start Monday?"')).toEqual(["Can you start Monday?"]);
    expect(extractQuestions("Rate? Why?")).toEqual(["Rate?", "Why?"]);
  });
});

async function render(ppd: ProposalPpd) {
  const compiled = compileProposalPdfme(ppd);
  const bytes = await generate({
    template: compiled.template,
    inputs: compiled.inputs,
    plugins: { text, line, rectangle },
    options: {
      font: {
        SourceSans3: { data: readFileSync(fontPath("SourceSans3-Regular.ttf")), fallback: true },
        SourceSans3Semibold: { data: readFileSync(fontPath("SourceSans3-Semibold.ttf")) },
      },
    },
  });
  return { compiled, pdf: await PDFDocument.load(bytes) };
}

describe("compileProposalPdfme · layout", () => {
  it("renders the example as A4 pages with Source Sans", async () => {
    const example = JSON.parse(
      readFileSync(fileURLToPath(new URL("../examples/ppd-example.json", import.meta.url)), "utf8"),
    ) as ProposalPpd;
    expect(assertPpdShape(example)).toEqual([]);
    const { compiled, pdf } = await render(example);
    expect(compiled.pages).toBeGreaterThanOrEqual(1);
    expect(pdf.getPageCount()).toBe(compiled.pages);
    expect(JSON.stringify(compiled.inputs)).not.toContain("Secret Agency");
    const names = compiled.template.schemas
      .flat()
      .filter((field) => field.type === "text")
      .map((field) => field.name)
      .sort();
    expect(Object.keys(compiled.inputs[0] ?? {}).sort()).toEqual(names);
    expect(Object.values(compiled.inputs[0] ?? {})).toContain(`Page 1 of ${compiled.pages}`);
  }, 30000);

  it("keeps every page instead of clipping after page two", async () => {
    const sections = Array.from({ length: 8 }, (_, index) => ({
      id: `section-${index}`,
      title: `Section ${index + 1}`,
      blocks: [
        {
          type: "paragraph",
          items: [
            "This paragraph explains the work in plain English and names the deliverables, the sequence and the acceptance criteria. ".repeat(12),
          ],
        },
      ],
    }));
    const ppd = sanitizePpd(rawPpd(), context());
    ppd.sections = sections as ProposalPpd["sections"];
    ppd.closing = "Thank you.";
    const { compiled, pdf } = await render(ppd);
    expect(compiled.pages).toBeGreaterThan(2);
    expect(pdf.getPageCount()).toBe(compiled.pages);
    const values = Object.values(compiled.inputs[0] ?? {});
    expect(values).toContain("Thank you.");
    for (let index = 1; index <= sections.length; index += 1) {
      expect(values).toContain(`SECTION ${index}`);
    }
    compiled.template.schemas.forEach((page, index) => {
      const footer = page.find((field) => field.name.startsWith("footer_page"));
      expect(footer).toBeTruthy();
      expect(compiled.inputs[0]?.[footer?.name ?? ""]).toBe(`Page ${index + 1} of ${compiled.pages}`);
    });
    for (const page of compiled.template.schemas) {
      for (const field of page) {
        expect(field.position.y).toBeGreaterThanOrEqual(0);
        expect(field.position.y + field.height).toBeLessThanOrEqual(297);
        expect(field.position.x).toBeGreaterThanOrEqual(0);
        expect(field.position.x + field.width).toBeLessThanOrEqual(210);
      }
    }
  }, 30000);
});