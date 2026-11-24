import { z } from "zod";
import { groqConfig } from "@/lib/env-extras";
import { logger } from "@/lib/logger";
import type {
  PpdBlock,
  PpdSection,
  ProposalOutput,
  ProposalPpd,
} from "@/types/lead";
import { ApiError } from "@/server/http/errors";

/**
 * The model is asked for the PPD block contract, but we never trust it:
 * every field is coerced, clipped, and given a placeholder when missing, and
 * *our own* identity (company, website, sender) is overwritten from the
 * environment so the model can never invent branding or a reply address.
 *
 * Caps mirror what `lib/pdfme/compiler.ts` lays out cleanly on a 4–6 page A4
 * document. Exceeding them is not an error — the compiler paginates — but a
 * runaway response is clipped so a bad generation can't produce a 40-page PDF.
 */

const MAX = {
  sections: 14,
  blocksPerSection: 10,
  itemsPerBlock: 20,
  heading: 90,
  paragraphItem: 1400,
  bulletItem: 400,
  stepTitle: 120,
  stepDescription: 900,
  requirement: 140,
  approach: 600,
  label: 80,
  value: 600,
  refName: 140,
  url: 300,
  title: 90,
  subtitle: 220,
  preparedFor: 160,
  rate: 160,
  engagement: 260,
  closing: 500,
  emailSubject: 120,
  /** Prompt targets 1,500–2,000 characters (~400–650 output tokens). */
  emailContent: 2600,
} as const;

/**
 * Calibrated against `lib/pdfme/compiler.ts` on this pipeline:
 * 565 words → 3 pages, 950 → 4, 1,134 → 4, 4,243 → 12.
 */
export const DOC_WORD_TARGET = { min: 700, ideal: 950, max: 2600 } as const;

/**
 * Nothing in a client-facing document is a hole for a human to fill. When a
 * detail genuinely is not in the post, we print a plain sentence saying how it
 * gets settled instead of a bracketed token.
 */
const UNCONFIRMED_PHRASE = "to be confirmed on the kickoff call";
const RATE_FALLBACK = "indicative — confirmed after a short scoping call";
const BRACKET_TOKEN = /\[([^\]\n]{0,90})\]/g;

/** Curated meanings for the placeholder tokens models reach for most. */
const BRACKET_MEANINGS: Array<[RegExp, string]> = [
  [/^(to( be)? (confirmed|decided|determined|filled|added|provided|shared)|tbc|tbd|tba|\?+|\.\.\.|…|x+|uodate|unknown)$/i, UNCONFIRMED_PHRASE],
  [/^(your |our |the )?(full )?(name|signature|sign-?off)$/i, "__NAME__"],
  [/^(your |our )?(pricing|price|rate|rate card|budget|hourly rate)$/i, RATE_FALLBACK],
  [/^(your |the )?(start|end|delivery|launch)[\s-]*(date|time|day)$/i, "__NAME__"],
  [/^(case stud(y|ies)|portfolio|references?|sample(s)?|link|url|demo(s)?)$/i, "available on request"],
  [/^(insert|add|fill|fill in|todo|fixme|placeholder|edit|replace|update)\b.*$/i, UNCONFIRMED_PHRASE],
  [/^(website|url|site)$/i, "__WEBSITE__"],
  [/^(email|e-mail|contact|reply address)$/i, "__EMAIL__"],
  [/^(company|studio|agency|our company)$/i, "__COMPANY__"],
];

/**
 * Our sign-off block doubles as the identity used to rewrite stray brackets,
 * so the email step needs no extra plumbing: "Best regards," / name /
 * "role · company" / site.
 */
function identityFromSignature(signature: string[]) {
  const [name = "", role = "", maybeSite = ""] = signature.slice(1);
  const [title, company] = role.includes("·")
    ? role.split("·").map((part) => part.trim())
    : ["", role.trim()];
  return {
    name: name || title,
    company: company || title,
    website: /^https?:\/\//i.test(maybeSite) ? maybeSite : "",
    email: maybeSite.includes("@") ? maybeSite : "",
    title,
  };
}

/** Said out loud to the reviewer whenever we had to rewrite a hole into prose. */
export function bracketWarnings(report: { count: number; samples: string[] }): string[] {
  if (!report.count) return [];
  const samples = report.samples.length ? ` (${report.samples.join(", ")})` : "";
  return [
    `the model left ${report.count} bracketed placeholder${report.count === 1 ? "" : "s"}${samples} — ` +
      "rewritten into plain sentences from our own details; check those lines",
  ];
}

/**
 * Bracketed tokens still present in a raw model response, before rewriting.
 * Reported as a warning so a prompt edit that loosens the rules is visible in
 * the dashboard instead of silently shipping to a client.
 */
export function findBracketTokens(value: unknown, limit = 4): { count: number; samples: string[] } {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const matches = text.match(BRACKET_TOKEN) ?? [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (!/^(to be|tbc|tbd|tba|your|our|the|insert|add|fill|todo|case|start|end|delivery|pricing|price|rate|budget|name|link|url|website|email|company|portfolio|reference|\?|\.)/i.test(match.slice(1, -1).trim())) {
      continue;
    }
    if (seen.size < limit) seen.add(match);
  }
  return { count: matches.length, samples: [...seen] };
}

/** Identity used while rewriting stray brackets — set once per sanitize pass. */
let bracketIdentity = {
  name: "",
  company: "",
  website: "",
  email: "",
  title: "",
};

export function setBracketIdentity(identity: Partial<typeof bracketIdentity>) {
  bracketIdentity = { ...bracketIdentity, ...identity };
}

/**
 * Remove `[something]` tokens from model output.
 *
 * A proposal that ships with `[TO CONFIRM]` in it tells the client nobody read
 * the brief. So instead of trusting the prompt, the sanitizer rewrites every
 * bracket: known placeholders become real prose, unknown ones lose their
 * brackets and read as the noun phrase the model meant. Brackets that survive
 * are a bug, so `findBracketTokens` is used to report them.
 */
function deBracket(value: string): string {
  if (!value.includes("[")) return value;
  const out = value.replace(BRACKET_TOKEN, (token, inner: string) => {
    const phrase = String(inner).replace(/\s+/g, " ").trim();
    // Never insert a phrase the sentence already says, or "…[YOUR PRICING]
    // indicative — confirmed after a short scoping call" would double up.
    const substitute = (candidate: string) =>
      candidate && value.toLowerCase().includes(candidate.toLowerCase()) ? "" : candidate;
    if (!phrase) return UNCONFIRMED_PHRASE;
    for (const [pattern, replacement] of BRACKET_MEANINGS) {
      if (!pattern.test(phrase)) continue;
      if (replacement === "__NAME__") {
        const name = bracketIdentity.name || bracketIdentity.company || "the team";
        return substitute(name);
      }
      if (replacement === "__COMPANY__") return substitute(bracketIdentity.company || "our studio");
      if (replacement === "__WEBSITE__") {
        return bracketIdentity.website ? substitute(bracketIdentity.website) : UNCONFIRMED_PHRASE;
      }
      if (replacement === "__EMAIL__") {
        return bracketIdentity.email ? substitute(bracketIdentity.email) : UNCONFIRMED_PHRASE;
      }
      return substitute(replacement);
    }
    // An all-caps token ("[START DATE]", "[QTY]") is a form field, not prose.
    if (!/[a-z]/.test(phrase) && phrase.length > 2) return UNCONFIRMED_PHRASE;
    // Otherwise keep the words the model meant and drop the brackets.
    const lowered = phrase.charAt(0).toLowerCase() + phrase.slice(1);
    const phraseOut = /^(a|an|the|this|that|our|your|their|some|any)\b/i.test(lowered) ? lowered : `the ${lowered}`;
    return substitute(phraseOut);
  });
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

const flat = (value: unknown, max: number): string => {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string") return "";
  return deBracket(value.replace(/\s+/g, " ").trim()).slice(0, max);
};

const soft = (value: unknown, max: number): string => {
  if (typeof value !== "string") return flat(value, max);
  return deBracket(
    value
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  ).slice(0, max);
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];

const pick = (source: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

/**
 * Our identity + lead facts that must not come from the model.
 * Built by `proposal.service.ts` from env + the stored lead.
 */
export interface ProposalContext {
  company: string;
  website: string;
  preparedBy: string;
  /** PROPOSAL_DEFAULT_RATE wins over anything the model invented. */
  rate?: string;
  senderEmail: string;
  jobTitle: string | null;
  jobReference: string | null;
  recipientName: string | null;
  recipientCompany: string | null;
  clientName: string | null;
  today: string;
  /**
   * Case studies / client references **we** have verified. The model is never a
   * source for these: a fabricated "production reference" in a proposal is both
   * a lie and an account-ban risk, so anything not matching this list is dropped.
   * Empty (today's default) ⇒ every reference the model returns is removed.
   */
  verifiedReferences?: Array<{ name: string; url: string }>;
}

/**
 * Model output → the PPD block contract. Our own identity always comes from
 * `ctx` (env + lead), never from the model.
 */
export function sanitizePpd(raw: unknown, ctx: ProposalContext): ProposalPpd {
  setBracketIdentity({
    name: ctx.preparedBy,
    company: ctx.company,
    website: ctx.website,
    email: ctx.senderEmail,
  });
  const obj = record(raw);
  const ppdRaw = record(
    pick(obj, ["ppd", "proposal", "document", "professional_proposal"]) ?? obj,
  );

  const sections = sanitizeSections(pick(ppdRaw, ["sections", "blocks", "content"]), ctx.verifiedReferences ?? []);
  if (sections.length === 0) {
    logger.warn("proposal_sections_missing", { keys: Object.keys(ppdRaw).slice(0, 12) });
  }

  const ppd: ProposalPpd = {
    // ↓ environment-authoritative, model output ignored on purpose
    company: ctx.company,
    prepared_by: ctx.preparedBy,
    website: ctx.website,
    job_title: ctx.jobTitle || flat(ppdRaw.job_title, MAX.heading),
    job_reference: ctx.jobReference || flat(ppdRaw.job_reference, 80),
    rate: ctx.rate?.trim() || flat(ppdRaw.rate, MAX.rate) || RATE_FALLBACK,
    // ↓ model-authored with fallbacks
    document_title:
      flat(ppdRaw.document_title, MAX.title) || "PROJECT CAPABILITY & PROPOSED WORKFLOW",
    subtitle:
      flat(ppdRaw.subtitle ?? ppdRaw.proposal_subtitle, MAX.subtitle) ||
      "A practical implementation plan based on your job post.",
    prepared_for:
      flat(ppdRaw.prepared_for, MAX.preparedFor) ||
      [ctx.recipientName, ctx.recipientCompany ?? ctx.clientName]
        .filter(Boolean)
        .join(" · ") ||
      "Hiring team",
    engagement: flat(ppdRaw.engagement, MAX.engagement) || "Discovery and milestones to be confirmed",
    sections: sections.length ? sections : fallbackSections(),
    closing:
      flat(ppdRaw.closing, MAX.closing) ||
      "Thank you for considering this proposal.",
  };

  return ppd;
}

/** What the email step may need when it runs as its own Groq call. */
export interface EmailContext {
  jobTitle: string;
  /** The reviewed document: used for fallback copy only. */
  ppd?: ProposalPpd | null;
  /**
   * Our own sign-off, appended after the model stops writing. The name, role,
   * company and site in a client email are never the model's to invent.
   */
  signature?: string[];
}

/** Closing lines a model likes to author, which we replace with the real ones. */
const SALUTATION = /^(best regards|kind regards|warm regards|regards|thanks( you)?( for (your|the)[^\n]*)?|thank you|sincerely|cheers|best|talk soon)\b[,!:]?\s*$/i;

/**
 * Cut any sign-off the model wrote and append ours.
 *
 * Only the last few lines are considered, and only short ones, so "Thanks for
 * the detailed post." in the first paragraph survives. Trailing blank lines are
 * removed so the block always sits one line below the ask.
 */
function withSignature(content: string, signature: string[]): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const from = Math.max(0, lines.length - 7);
  let cut = lines.length;
  for (let i = lines.length - 1; i >= from; i -= 1) {
    const line = (lines[i] ?? "").trim();
    if (line.length <= 45 && SALUTATION.test(line)) {
      cut = i;
      break;
    }
  }
  const body = lines
    .slice(0, cut)
    .join("\n")
    .replace(/\s+$/, "")
    .trim();
  if (!signature.length) return body;
  return `${body}\n\n${signature.map((line) => line.trim()).filter(Boolean).join("\n")}`;
}

/** Model output → the outreach email (plain text, short subject). */
export function sanitizeEmail(raw: unknown, ctx: EmailContext): { subject: string; content: string } {
  const signature = ctx.signature?.filter(Boolean) ?? [];
  setBracketIdentity(identityFromSignature(signature));
  const obj = record(raw);
  const emailRaw = record(pick(obj, ["email", "outreach_email", "email_draft"]) ?? obj);
  const ppd = ctx.ppd ?? null;

  const subject =
    clampSubject(stripMarkdown(flat(emailRaw.subject, MAX.emailSubject))) ||
    clampSubject(`Re: ${ctx.jobTitle || "your job post"}`);

  const fallbackBody = ppd
    ? `${ppd.subtitle}\n\n${ppd.sections
        .flatMap((s) => s.blocks)
        .filter((b) => b.type === "paragraph")
        .map((b) => (b as { items: string[] }).items[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("\n\n")}\n\nFull proposal attached as a PDF. Are you open to a quick 15-minute call this week?`
    : `We would like to help with ${ctx.jobTitle || "this project"}. Full proposal attached as a PDF — are you open to a quick 15-minute call this week?`;

  const budget = Math.max(400, MAX.emailContent - signature.reduce((n, l) => n + l.length + 1, 2));
  const content = withSignature(
    stripMarkdown(soft(pick(emailRaw, ["content", "body", "text", "email_content"]) ?? fallbackBody, budget)) ||
      fallbackBody,
    signature,
  );

  const parsed = z
    .object({ subject: z.string().min(1), content: z.string().min(1) })
    .safeParse({ subject, content });
  if (!parsed.success) {
    throw ApiError.upstream("Groq response had no usable email subject/body");
  }
  return parsed.data;
}

/** One pass for a response that carries both halves (legacy single-call prompt). */
export function sanitizeProposal(raw: unknown, ctx: ProposalContext): ProposalOutput {
  const ppd = sanitizePpd(raw, ctx);
  const email = sanitizeEmail(raw, { jobTitle: ppd.job_title, ppd });
  return { ppd, email };
}

/* ─────────────────────────────── sections ─────────────────────────────── */

function sanitizeSections(value: unknown, verifiedReferences: Array<{ name: string; url: string }>): PpdSection[] {
  const source = array(value);
  const sections: PpdSection[] = [];

  source.forEach((entry, index) => {
    const raw = record(entry);
    const title = flat(pick(raw, ["title", "heading", "name"]), MAX.heading);
    const id =
      flat(raw.id, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
      slug(title) ||
      `section-${index + 1}`;

    const blocksRaw = array(pick(raw, ["blocks", "content", "body"]));
    const blocks: PpdBlock[] = [];
    for (const blockRaw of blocksRaw) {
      const block = toBlock(blockRaw, verifiedReferences);
      if (block) blocks.push(block);
      if (blocks.length >= MAX.blocksPerSection) break;
    }

    // A section whose blocks were all unusable is dropped, and a block-less
    // model answer ({"title": "Scope", "items": [...]}) is rescued as bullets.
    let finalBlocks = blocks;
    if (!finalBlocks.length) {
      const rescued = toBlock({ ...raw, type: raw.type ?? "auto" }, verifiedReferences);
      if (rescued) finalBlocks = [rescued];
    }
    if (!title && !finalBlocks.length) return;
    sections.push({ id, title, blocks: finalBlocks });
  });

  return dedupeIds(sections).slice(0, MAX.sections);
}

function dedupeIds(sections: PpdSection[]): PpdSection[] {
  const seen = new Map<string, number>();
  return sections.filter((section) => {
    const n = (seen.get(section.id) ?? 0) + 1;
    seen.set(section.id, n);
    section.id = n === 1 ? section.id : `${section.id}-${n}`;
    return section.blocks.length > 0;
  });
}

/** Accepts the seven documented block types plus the shapes models drift to. */
function toBlock(value: unknown, verifiedReferences: Array<{ name: string; url: string }>): PpdBlock | null {
  const raw = record(value);
  const type = flat(raw.type, 40).toLowerCase();
  const items = array(pick(raw, ["items", "bullets", "points", "paragraphs", "steps", "rows"]));
  const text = soft(pick(raw, ["text", "body", "content", "note"]), MAX.paragraphItem);

  if (type === "note") {
    return text ? { type: "note", text } : null;
  }

  if (type === "paragraph" || type === "paragraphs" || type === "narrative" || type === "text") {
    const list = items.length ? items : text ? [text] : [];
    const lines = list
      .map((item) => soft(typeof item === "object" ? pick(record(item), ["text", "value", "body"]) : item, MAX.paragraphItem))
      .filter(Boolean)
      .slice(0, MAX.itemsPerBlock);
    return lines.length ? { type: "paragraph", items: lines } : null;
  }

  if (type === "bullets" || type === "bullet" || type === "list" || type === "ul") {
    const lines = items
      .map((item) =>
        flat(
          typeof item === "object"
            ? pick(record(item), ["text", "item", "label", "value", "title", "name"])
            : item,
          MAX.bulletItem,
        ),
      )
      .filter(Boolean)
      .slice(0, MAX.itemsPerBlock);
    return lines.length ? { type: "bullets", items: lines } : null;
  }

  if (type === "numberedsteps" || type === "steps" || type === "phases" || type === "workflow") {
    const steps = items
      .map((entry) => {
        const step = record(entry);
        if (typeof entry === "string") {
          return { title: flat(entry, MAX.stepTitle), description: "" };
        }
        const title = flat(pick(step, ["title", "name", "label", "phase"]), MAX.stepTitle);
        const description = soft(
          pick(step, ["description", "text", "detail", "body"]),
          MAX.stepDescription,
        );
        return title || description ? { title: title || `Step`, description } : null;
      })
      .filter((s): s is { title: string; description: string } => Boolean(s))
      .slice(0, MAX.itemsPerBlock);
    return steps.length ? { type: "numberedSteps", items: steps } : null;
  }

  if (type === "capabilitymatrix" || type === "matrix" || type === "requirements") {
    const pairs = items
      .map((entry) => {
        const cap = record(entry);
        return {
          requirement: flat(pick(cap, ["requirement", "label", "need", "name"]), MAX.requirement),
          approach: soft(pick(cap, ["approach", "value", "how", "response", "text"]), MAX.approach),
        };
      })
      .filter((pair) => pair.requirement || pair.approach)
      .slice(0, MAX.itemsPerBlock);
    return pairs.length ? { type: "capabilityMatrix", items: pairs } : null;
  }

  if (type === "keyvaluetable" || type === "table" || type === "terms" || type === "details") {
    const rowsSource = array(pick(raw, ["rows", "entries", "terms"])).length
      ? array(pick(raw, ["rows", "entries", "terms"]))
      : items;
    const rows = rowsSource
      .map((entry) => {
        const row = record(entry);
        return {
          label: flat(pick(row, ["label", "term", "name", "key"]), MAX.label),
          value: soft(pick(row, ["value", "detail", "text", "notes"]), MAX.value),
        };
      })
      .filter((row) => row.label || row.value)
      .slice(0, MAX.itemsPerBlock);
    return rows.length ? { type: "keyValueTable", rows } : null;
  }

  if (type === "references" || type === "reference" || type === "portfolio") {
    const allow = new Set(verifiedReferences.map((r) => normalizeUrl(r.url)));
    const refs = items
      .map((entry) => {
        const ref = record(entry);
        return {
          name: flat(pick(ref, ["name", "title", "label"]), MAX.refName),
          url: flat(pick(ref, ["url", "link", "href"]), MAX.url),
          verified: ref.verified === true,
        };
      })
      // Hard rule: a reference only survives when *we* vouch for its URL, so a
      // confident-sounding "production reference" from the model can't ship.
      .filter((ref) => {
        const ok = allow.has(normalizeUrl(ref.url));
        if (!ok && (ref.name || ref.url)) {
          logger.warn("proposal_reference_dropped", { name: ref.name, url: ref.url });
        }
        return ok;
      })
      .slice(0, MAX.itemsPerBlock);
    return refs.length ? { type: "references", items: refs } : null;
  }

  // Untyped block: infer from what it carries.
  if (items.length) {
    const objects = items.every((item) => typeof item === "object");
    if (objects) {
      const first = record(items[0]);
      if ("requirement" in first || "approach" in first)
        return toBlock({ type: "capabilityMatrix", items }, verifiedReferences);
      if ("label" in first || "value" in first)
        return toBlock({ type: "keyValueTable", rows: items }, verifiedReferences);
      if ("title" in first || "description" in first)
        return toBlock({ type: "numberedSteps", items }, verifiedReferences);
    }
    return toBlock({ type: "bullets", items }, verifiedReferences);
  }
  if (text) return toBlock({ type: "paragraph", items: [text] }, verifiedReferences);
  return null;
}

const normalizeUrl = (value: string) => value.toLowerCase().replace(/[\/.]+$/, "").trim();

/**
 * Tell a human reviewer what their edit lost.
 *
 * `sanitizePpd` legitimately throws away content that cannot be rendered — an
 * empty block, empty list lines, a reference nobody vouches for, anything past
 * the per-section caps. Silently doing that is exactly how "I edited it and my
 * change disappeared" looks, so the edit endpoint walks the submitted document
 * and reports each drop in plain words.
 */
export function describePpdEditDrops(
  input: unknown,
  verifiedReferences: Array<{ name: string; url: string }> = [],
): string[] {
  const notes: string[] = [];
  const obj = record(input);
  const ppdRaw = record(pick(obj, ["ppd", "proposal", "document", "professional_proposal"]) ?? obj);
  const sectionsRaw = array(pick(ppdRaw, ["sections", "blocks", "content"]));
  if (!sectionsRaw.length) return ["no sections in the submitted document — the stored text was kept"];

  sectionsRaw.slice(MAX.sections).forEach((_, offset) => {
    notes.push(
      `section ${MAX.sections + offset + 1} dropped: a document holds at most ${MAX.sections} sections`,
    );
  });

  sectionsRaw.slice(0, MAX.sections).forEach((entry, index) => {
    const raw = record(entry);
    const title =
      flat(pick(raw, ["title", "heading", "name"]), 60) ||
      flat(raw.id, 40) ||
      `section ${index + 1}`;
    const blocksRaw = array(pick(raw, ["blocks", "content", "body"]));

    blocksRaw.slice(MAX.blocksPerSection).forEach((extra, offset) => {
      notes.push(
        `“${title}”: block ${MAX.blocksPerSection + offset + 1} dropped (${MAX.blocksPerSection} per section is the limit)`,
      );
    });

    blocksRaw.slice(0, MAX.blocksPerSection).forEach((blockRaw, blockIndex) => {
      const block = toBlock(blockRaw, verifiedReferences);
      const type = flat(record(blockRaw).type, 40) || "untyped";
      if (!block) {
        if (type === "references" || type === "reference" || type === "portfolio") {
          notes.push(
            `“${title}” block ${blockIndex + 1}: every reference was dropped — only URLs we have verified ourselves can be printed`,
          );
        } else {
          notes.push(`“${title}” block ${blockIndex + 1} (${type}) dropped: it contained no text`);
        }
        return;
      }

      const inItems = array(
        pick(record(blockRaw), ["items", "bullets", "points", "paragraphs", "steps", "rows"]),
      ).length;
      const outItems =
        block.type === "keyValueTable" ? block.rows.length : block.type === "note" ? 1 : block.items.length;

      if (inItems > outItems) {
        const lost = inItems - outItems;
        notes.push(
          block.type === "references"
            ? `“${title}”: ${lost} reference(s) dropped — only URLs we have verified can be printed`
            : `“${title}”: ${lost} empty line(s) removed from the ${block.type} block`,
        );
      }
    });
  });

  return notes.slice(0, 8);
}

function fallbackSections(): PpdSection[] {
  return [
    {
      id: "understanding",
      title: "Project understanding",
      blocks: [
        {
          type: "paragraph",
          items: [
            `${UNCONFIRMED_PHRASE} — the model did not return usable sections; regenerate this proposal before sending.`,
          ],
        },
      ],
    },
  ];
}

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/**
 * Subjects come back as the entire job title (105 chars in a measured run),
 * which Upwork and Gmail both truncate. Keep it under the ~70-char preview.
 */
function clampSubject(value: string): string {
  const bare = value.replace(/^(re:\s*)+/i, "").trim();
  if (!bare) return "Proposal";
  if (bare.length <= 70) return bare;
  const window = bare.slice(0, 67);
  const breakAt = Math.max(window.lastIndexOf(" "), window.lastIndexOf("/"), window.lastIndexOf("-"));
  const head = breakAt > 30 ? window.slice(0, breakAt) : window;
  return `${head.replace(/[,;:\-\s/.]+$/, "")}…`;
}

/** Emails are plain text: drop markdown syntax the model may add anyway. */
function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // [text](url) → "text (url)": the link survives, the syntax does not.
    .replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-•]\s+/gm, "• ")
    .replace(/^\s*Subject:\s*/i, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/* ────────────────────────────── diagnostics ───────────────────────────── */

/** All visible document text — used for budget checks and the dashboard stats. */
export function ppdWordCount(ppd: ProposalPpd): number {
  return ppdPlainText(ppd).split(/\s+/).filter(Boolean).length;
}

export function ppdPlainText(ppd: ProposalPpd): string {
  const parts: string[] = [
    ppd.company,
    ppd.document_title,
    ppd.subtitle,
    ppd.prepared_for,
    ppd.prepared_by,
    ppd.rate,
    ppd.engagement,
    ppd.job_title,
  ];
  for (const section of ppd.sections) {
    parts.push(section.title);
    for (const block of section.blocks) {
      switch (block.type) {
        case "paragraph":
        case "bullets":
          parts.push(...block.items);
          break;
        case "note":
          parts.push(block.text);
          break;
        case "numberedSteps":
          for (const step of block.items) parts.push(step.title, step.description);
          break;
        case "capabilityMatrix":
          for (const cap of block.items) parts.push(cap.requirement, cap.approach);
          break;
        case "keyValueTable":
          for (const row of block.rows) parts.push(row.label, row.value);
          break;
        case "references":
          for (const ref of block.items) parts.push(ref.name, ref.url);
          break;
      }
    }
  }
  parts.push(ppd.closing);
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
}

/** Completion-budget guard shared by both prompt stages. */
function usageWarnings(
  usage: { prompt_tokens: number; completion_tokens: number } | null | undefined,
  budgetOverride?: number | null,
): string[] {
  if (!usage) return [];
  const budget = budgetOverride ?? groqConfig().maxTokens;
  if (usage.completion_tokens < budget * 0.95) return [];
  // GPT-OSS bills its hidden reasoning against the same completion cap, so a run
  // that lands on it was almost certainly cut off mid-JSON.
  return [
    `completion used ${usage.completion_tokens} of the ${budget}-token budget — the output may be truncated; raise max_tokens on this prompt or set reasoning_effort to low`,
  ];
}

/** Cheap quality gate for the PPD step: returned as API `warnings[]`, never blocks a save. */
export function assertPpdShape(
  ppd: ProposalPpd,
  usage?: { prompt_tokens: number; completion_tokens: number } | null,
  maxTokensOverride?: number | null,
): string[] {
  const problems: string[] = [];
  const words = ppdWordCount(ppd);

  if (ppd.sections.length < 5) {
    problems.push(`only ${ppd.sections.length} sections — expected 10 for a 4–6 page document`);
  }
  if (words < DOC_WORD_TARGET.min) {
    problems.push(`document is ~${words} words, below the ${DOC_WORD_TARGET.min}-word floor`);
  }
  if (words > DOC_WORD_TARGET.max) {
    problems.push(`document is ~${words} words, above the ${DOC_WORD_TARGET.max}-word cap`);
  }
  // `deBracket()` runs before this, so anything still bracketed is a hole in the
  // sanitizer rather than a model mistake — say so instead of telling a human to
  // fill in a form field.
  const stray = ppdPlainText(ppd).match(/\[[^\]\n]{0,60}\]/g) ?? [];
  if (stray.length) {
    problems.push(
      `${stray.length} bracketed token(s) survived sanitising (${stray.slice(0, 3).join(", ")}) — report this, do not fill them by hand`,
    );
  }

  const all = [...problems, ...usageWarnings(usage, maxTokensOverride)];
  if (all.length) logger.warn("proposal_low_quality", { problems: all });
  return all;
}

/** Cheap quality gate for the email step. */
export function assertEmailShape(
  email: { subject: string; content: string },
  usage?: { prompt_tokens: number; completion_tokens: number } | null,
  maxTokensOverride?: number | null,
): string[] {
  const problems: string[] = [];
  const words = email.content.split(/\s+/).filter(Boolean).length;

  if (!email.subject.trim()) problems.push("email.subject is empty");
  if (email.subject.length > 70) problems.push("email.subject is longer than 70 chars");
  if (words < 70) problems.push("email.content is very short (<70 words)");
  if (email.content.length > 1800) problems.push("email.content exceeds the 700–1,200 char target");

  const all = [...problems, ...usageWarnings(usage, maxTokensOverride)];
  if (all.length) logger.warn("email_low_quality", { problems: all });
  return all;
}

/** Both stages at once (used by the legacy single-call prompt). */
export function assertProposalShape(
  output: ProposalOutput,
  usage?: { prompt_tokens: number; completion_tokens: number } | null,
): string[] {
  return [
    ...assertPpdShape(output.ppd, usage),
    ...assertEmailShape(output.email, null),
  ];
}
