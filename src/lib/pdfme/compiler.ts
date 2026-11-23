import type {
  LegacyProposalPpd,
  PpdBlock,
  PpdSection,
  ProposalPpd,
} from "@/types/lead";
import type { PdfmeField, PdfmeTemplate } from "./template";

/**
 * PPD → a *complete* pdfme template + inputs, generated per proposal.
 *
 * This is the TypeScript port of `compile_pdfme.py` from the Blueoak PDFme
 * package, and it replaces the old fixed-slot mapper: instead of squeezing the
 * document into `deliverable_1..6` style slots inside a static template, we
 * emit one positioned `text` field per **wrapped line**, then flow them down an
 * A4 page and start a new page when the cursor passes the bottom margin.
 * Consequences:
 *  - document length is unlimited (2 pages or 8), nothing gets clipped;
 *  - every field is an ordinary pdfme `text` schema, so the result imports into
 *    the PDFme Designer with no custom plugins;
 *  - the footer (rule + job title + `n / total`) is regenerated on each page.
 *
 * pdfme model reminder: `template.schemas[page] = fields[]`, and `inputs` is a
 * list of **documents** — so we return exactly one record `[values]` covering
 * all pages. All geometry is millimetres.
 */

export const PDFME_VERSION = "6.2.8"; // keep equal to the pinned @pdfme/* versions

const W = 210;
const H = 297;
const LEFT = 20;
const TOP = 20;
const BOTTOM = 273;
const CONTENT_W = 170;

const NAVY = "#193753";
const INK = "#243746";
const MUTED = "#53677B";
const TEAL = "#177A89";
const RULE = "#B3C6D1";
const SHADE = "#EDF4F8";

export type PdfmeInputs = Array<Record<string, string>>;

export interface CompiledProposalPdfme {
  template: PdfmeTemplate;
  inputs: PdfmeInputs;
  pages: number;
  fieldCount: number;
}

type AddOptions = {
  x?: number;
  width?: number;
  height?: number;
  font?: number;
  color?: string;
  y?: number;
  background?: string;
};

class ProposalBuilder {
  private readonly data: ProposalPpd;
  private pages: PdfmeField[][] = [[]];
  private values: Record<string, string> = {};
  private y = TOP;
  private counter = 0;

  constructor(data: ProposalPpd) {
    this.data = data;
  }

  build(): CompiledProposalPdfme {
    const d = this.data;

    this.add("eyebrow", `${(d.company || "Proposal").toUpperCase()}  /  PROFESSIONAL PROPOSAL`, {
      height: 6,
      font: 8,
      color: TEAL,
    });
    this.y += 11;

    for (const line of wrap(d.document_title, 38)) {
      this.add("title", line, { height: 10, font: 17, color: NAVY });
      this.y += 10;
    }
    this.y += 3;

    for (const line of wrap(d.subtitle, 91)) {
      this.add("subtitle", line, { height: 6, font: 9, color: MUTED });
      this.y += 6;
    }
    this.y += 7;

    for (const [label, value] of this.headerRows()) {
      if (value) this.row(label, value);
    }
    this.y += 5;

    for (const section of d.sections ?? []) {
      const blocks = section.blocks ?? [];
      const hasContent = blocks.some(
        (block) =>
          (blockItems(block).length > 0) ||
          (block.type === "note" && block.text.trim().length > 0),
      );
      if (!hasContent) continue;
      if (section.title) this.heading(section.title);

      for (const block of blocks) {
        switch (block.type) {
          case "paragraph":
            for (const item of block.items) this.paragraph(item);
            break;
          case "note":
            this.paragraph(block.text, { color: MUTED });
            break;
          case "bullets":
            for (const item of block.items) this.listItem(item);
            this.y += 2;
            break;
          case "numberedSteps":
            block.items.forEach((step, index) => {
              this.ensure(16);
              this.add("step", `${String(index + 1).padStart(2, "0")}  ${step.title}`, {
                height: 7,
                font: 10,
                color: NAVY,
              });
              this.y += 8;
              this.paragraph(step.description, { indent: 8 });
            });
            break;
          case "capabilityMatrix":
            for (const cap of block.items) this.row(cap.requirement, cap.approach);
            break;
          case "keyValueTable":
            for (const pair of block.rows) this.row(pair.label, pair.value);
            break;
          case "references":
            for (const ref of block.items) {
              if (ref.verified && ref.url) {
                this.listItem(`${ref.name} — ${ref.url}`);
              }
            }
            break;
        }
      }
    }

    if (d.closing) {
      this.y += 3;
      this.paragraph(d.closing);
    }
    if (d.prepared_by) {
      this.ensure(16);
      this.add("signature", d.prepared_by, { height: 7, font: 11, color: NAVY });
      this.y += 9;
    }
    if (d.website) {
      this.ensure(8);
      this.add("website", d.website, { height: 6, font: 9, color: TEAL });
      this.y += 7;
    }

    this.addFooters();

    const template: PdfmeTemplate = {
      pdfmeVersion: PDFME_VERSION,
      basePdf: { width: W, height: H, padding: [0, 0, 0, 0] },
      schemas: this.pages,
    };

    return {
      template,
      inputs: [this.values],
      pages: this.pages.length,
      fieldCount: this.pages.reduce((sum, page) => sum + page.length, 0),
    };
  }

  /** Meta rows: fixed order, only the ones we actually know. */
  private headerRows(): Array<[string, string]> {
    const d = this.data;
    return [
      ["Prepared for", d.prepared_for],
      ["Prepared by", d.prepared_by],
      ["Proposed rate", d.rate],
      ["Engagement", d.engagement],
      ["Job reference", d.job_reference],
    ];
  }

  private addFooters() {
    const count = this.pages.length;
    const jobTitle = truncate(this.data.job_title || "PROJECT PROPOSAL", 100);

    for (const [index, page] of this.pages.entries()) {
      // Footers sit at a fixed y, so they bypass the flowing cursor entirely.
      const push = (name: string, content: string, opts: AddOptions & { y: number }) => {
        this.counter += 1;
        const key = `${name}_${String(this.counter).padStart(4, "0")}`;
        page.push(this.field(key, content, opts));
        this.values[key] = String(content);
      };

      push("footer_rule", "_".repeat(60), {
        x: LEFT,
        width: CONTENT_W,
        y: 277,
        height: 3,
        font: 8,
        color: RULE,
      });
      push("footer_job_title", jobTitle, {
        x: LEFT,
        width: 153,
        y: 282,
        height: 7,
        font: 7,
        color: MUTED,
      });
      push("footer_page", `${index + 1} / ${count}`, {
        x: 176,
        width: 14,
        y: 282,
        height: 7,
        font: 8,
        color: NAVY,
      });
    }
  }

  private paragraph(value: string, opts: { indent?: number; color?: string } = {}) {
    const indent = opts.indent ?? 0;
    const lines = wrap(value, indent === 0 ? 95 : 89);
    this.ensure(lines.length * 5.3 + 2);
    for (const line of lines) {
      this.add("paragraph", line, {
        x: LEFT + indent,
        width: CONTENT_W - indent,
        height: 5.3,
        font: 9,
        color: opts.color ?? INK,
      });
      this.y += 5.3;
    }
    this.y += 2;
  }

  private heading(value: string) {
    this.ensure(17);
    this.y += 5;
    this.add("section_heading", value, { height: 8, font: 12, color: NAVY });
    this.y += 10;
  }

  private listItem(value: string, prefix = "•") {
    const lines = wrap(value, 91);
    this.ensure(lines.length * 5.5 + 2);
    lines.forEach((line, index) => {
      this.add("list", `${index === 0 ? `${prefix}  ` : "   "}${line}`, {
        x: LEFT + 2,
        width: CONTENT_W - 3,
        height: 5.5,
        font: 9,
      });
      this.y += 5.5;
    });
    this.y += 1;
  }

  /** Shaded two-column row: label (navy) | value. Height = the taller cell. */
  private row(label: string, value: string) {
    const labelLines = wrap(label, 34);
    const valueLines = wrap(value, 66);
    const height = Math.max(labelLines.length, valueLines.length) * 5.7 + 2;
    this.ensure(height);

    const top = this.y;
    this.add("table_shade", "", { width: CONTENT_W, height, y: top, background: SHADE });
    labelLines.forEach((line, index) => {
      this.add("table_key", line, {
        x: LEFT + 3,
        width: 58,
        height: 5.7,
        font: 9,
        color: NAVY,
        y: top + 1 + index * 5.7,
      });
    });
    valueLines.forEach((line, index) => {
      this.add("table_value", line, {
        x: LEFT + 62,
        width: 105,
        height: 5.7,
        font: 9,
        y: top + 1 + index * 5.7,
      });
    });

    this.y = top + height + 2;
  }

  private ensure(height: number) {
    if (this.y + height > BOTTOM) this.newPage();
  }

  private newPage() {
    this.pages.push([]);
    this.y = TOP;
  }

  private add(name: string, content: string, opts: AddOptions = {}) {
    this.counter += 1;
    const key = `${name}_${String(this.counter).padStart(4, "0")}`;
    const page = this.pages[this.pages.length - 1];
    if (page) page.push(this.field(key, content, opts));
    this.values[key] = String(content);
  }

  private field(name: string, content: string, opts: AddOptions & { y?: number }): PdfmeField {
    const font = opts.font ?? 10;
    return {
      name,
      type: "text",
      position: { x: round2(opts.x ?? LEFT), y: round2(opts.y ?? this.y) },
      width: round2(opts.width ?? CONTENT_W),
      height: round2(opts.height ?? 7),
      content: String(content),
      fontSize: font,
      fontColor: opts.color ?? INK,
      backgroundColor: opts.background ?? "",
      verticalAlignment: "middle",
      alignment: "left",
      lineHeight: 1.15,
      readOnly: false,
      required: false,
      // Belt and braces: the wrap widths below are conservative, but if a font
      // metrics difference pushes a line over, pdfme shrinks it instead of
      // clipping it. `fit` is required by the v6 text schema.
      dynamicFontSize: { min: Math.max(5, font - 2), max: font, fit: "vertical" },
    };
  }
}

/**
 * Compile any stored PPD. Accepts the legacy flat shape too (rows written before
 * this change), so `GET /api/leads/:id/pdf?render=true` still works on old
 * proposals.
 */
export function compileProposalPdfme(
  input: ProposalPpd | LegacyProposalPpd | Record<string, unknown> | null | undefined,
): CompiledProposalPdfme {
  return new ProposalBuilder(toBlockPpd(input)).build();
}

export const PAGE_METRICS = { width: W, height: H, left: LEFT, top: TOP, bottom: BOTTOM };

/* ────────────────────────────── helpers ────────────────────────────── */

function blockItems(block: PpdBlock): string[] {
  switch (block.type) {
    case "paragraph":
    case "bullets":
      return block.items;
    case "numberedSteps":
      return block.items.map((i) => `${i.title} ${i.description}`.trim());
    case "capabilityMatrix":
      return block.items.map((i) => `${i.requirement} ${i.approach}`.trim());
    case "keyValueTable":
      return block.rows.map((r) => `${r.label} ${r.value}`.trim());
    case "references":
      return block.items.map((r) => r.url);
    case "note":
      return [block.text];
  }
}

/** Greedy word wrap with hard breaks for over-long words (≈ python textwrap). */
export function wrap(value: unknown, width: number): string[] {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of text.split(" ")) {
    let chunk = word;
    while (chunk.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      lines.push(chunk.slice(0, width));
      chunk = chunk.slice(width);
    }
    if (!current) {
      current = chunk;
    } else if ((`${current} ${chunk}`).length <= width) {
      current = `${current} ${chunk}`;
    } else {
      lines.push(current);
      current = chunk;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Legacy flat PPD → block PPD, so documents written before the block contract
 * still render. Field names mirror `LegacyProposalPpd`.
 */
function toBlockPpd(input: unknown): ProposalPpd {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (Array.isArray(raw.sections)) return raw as unknown as ProposalPpd;

  const legacy = raw as unknown as LegacyProposalPpd;
  const sections: PpdSection[] = [];
  const push = (id: string, title: string, blocks: PpdBlock[]) => {
    if (blocks.length) sections.push({ id, title, blocks });
  };

  const intro = [legacy.understanding, legacy.engagement_summary].filter(
    (v) => typeof v === "string" && v.trim(),
  ) as string[];
  push("understanding", "Project understanding", intro.length ? [{ type: "paragraph", items: intro }] : []);
  push(
    "scope",
    String(legacy.scope_title ?? "") || "Scope of work",
    legacy.deliverables?.length ? [{ type: "bullets", items: legacy.deliverables }] : [],
  );
  push(
    "approach",
    "Approach",
    legacy.approach?.length ? [{ type: "bullets", items: legacy.approach }] : [],
  );
  push(
    "why-us",
    "Why work with us",
    legacy.why_us?.length ? [{ type: "bullets", items: legacy.why_us }] : [],
  );

  const terms: Array<{ label: string; value: string }> = [];
  for (const n of [1, 2, 3]) {
    const label = String(raw[`timeline_label_${n}`] ?? "").trim();
    const value = String(raw[`timeline_value_${n}`] ?? "").trim();
    if (label || value) terms.push({ label: label || `Phase ${n}`, value });
  }
  for (const n of [1, 2]) {
    const name = String(raw[`pricing_option_${n}_name`] ?? "").trim();
    const price = String(raw[`pricing_option_${n}_price`] ?? "").trim();
    const notes = String(raw[`pricing_option_${n}_notes`] ?? "").trim();
    if (name || price || notes) {
      terms.push({ label: name || `Option ${n}`, value: [price, notes].filter(Boolean).join(" — ") });
    }
  }
  push(
    "terms",
    String(legacy.pricing_title ?? "") || "Timeline & commercial terms",
    terms.length ? [{ type: "keyValueTable", rows: terms }] : [],
  );

  const extras = [...(legacy.includes ?? []), ...(legacy.assumptions ?? [])];
  push("inclusions", "What's included & assumptions", extras.length ? [{ type: "bullets", items: extras }] : []);
  push(
    "next-steps",
    "Next steps",
    legacy.next_steps?.length ? [{ type: "bullets", items: legacy.next_steps }] : [],
  );
  push("note", "", legacy.footer_note ? [{ type: "note", text: legacy.footer_note }] : []);

  return {
    company: String(raw.prepared_by ?? raw.company ?? ""),
    document_title: String(legacy.document_title ?? "Proposal"),
    subtitle: String(legacy.proposal_subtitle ?? ""),
    job_title: String(raw.job_title ?? ""),
    job_reference: String(raw.job_reference ?? ""),
    prepared_for: String(raw.prepared_for ?? ""),
    prepared_by: String(raw.prepared_by ?? raw.contact_name_signature ?? ""),
    rate: "",
    engagement: [raw.valid_until ? `Valid until ${raw.valid_until}` : "", raw.job_url ?? ""]
      .filter(Boolean)
      .join(" · "),
    website: String(raw.contact_email ?? ""),
    sections,
    closing: String(legacy.closing_note ?? ""),
  };
}
