import { describe, expect, it } from "vitest";

import { DEFAULT_PROMPTS } from "@/server/services/prompts/proposal.prompt";

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
