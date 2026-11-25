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

  it("covers requirements, the PPD approach, references and every question", () => {
    expect(prompt.system).toContain("CLIENT REQUIREMENTS AND PROJECT APPROACH");
    expect(prompt.system).toContain("reviewed PPD");
    expect(prompt.system).toContain("Answer EVERY question or direct request");
    expect(prompt.system).toContain("Use web search");
    expect(prompt.system).toContain("experience/approach paragraph");
    expect(prompt.system).toContain("Professional, technical");
    expect(prompt.user).toContain("{{research_notes}}");
    expect(prompt.user).toContain("{{job_questions}}");
    expect(prompt.user).toContain("{{ppd_summary}}");
  });
});