import type {
  LegacyProposalPpd,
  PpdBlock,
  PpdSection,
  ProposalPpd,
} from "@/types/lead";
import type { PdfmeField, PdfmeTemplate } from "./template";

/**
 * PPD → a compact, two-page A4 proposal for pdfme.
 *
 * The layout is deliberately simple: a navy identity band, the client/date
 * block, then the reviewed prose. It is generated per document because the
 * page count must never depend on a designer file, and a proposal must never
 * grow past two pages: the prompt targets 450–700 words and this builder
 * refuses to open page three. Longer text is clipped at the page-2 footer.
 *
 * Fonts are Source Sans 3 (OFL) because a generic serif/Helvetica mix is what
 * makes a proposal look like a template rather than a letter.
 */

export const PDFME_VERSION = "6.2.8"; // keep equal to the pinned @pdfme/* versions

const W = 210;
const H = 297;
const LEFT = 16;
const RIGHT = 194;
const TOP = 34;
const BOTTOM = 276;
const CONTENT_W = RIGHT - LEFT; // 178mm

const NAVY = "#1E3A8A";
const NAVY_DARK = "#172554";
const INK = "#1F2937";
const MUTED = "#6B7280";
const LIGHT = "#E5E7EB";
const SHADE = "#F3F6FA";
const WHITE = "#FFFFFF";
const BLUE_SOFT = "#DBEAFE";

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
  bold?: boolean;
  lineHeight?: number;
  align?: "left" | "center" | "right";
};

class ProposalBuilder {
  private readonly data: ProposalPpd;
  private pages: PdfmeField[][] = [[]];
  private values: Record<string, string> = {};
  private y = TOP;
  private counter = 0;
  private full = false;

  constructor(data: ProposalPpd) {
    this.data = data;
  }

  build(): CompiledProposalPdfme {
    this.firstPageHeader();
    this.clientAndDate();

    for (const section of this.data.sections ?? []) {
      if (this.full) break;
      const blocks = (section.blocks ?? []).filter((block) => blockHasContent(block));
      const first = blocks[0];
      if (!first) continue;
      // Keep the heading with a useful piece of its first block. Without this,
      // a section title can sit alone at the foot of page one while its table
      // starts on page two.
      if (!this.ensure(9 + this.blockMinimumHeight(first))) break;
      this.sectionHeading(section.title || "Details");
      for (const block of blocks) {
        if (this.full) break;
        this.block(block);
      }
      this.y += 3;
    }

    if (!this.full && this.data.closing) {
      this.divider();
      for (const line of wrap(this.data.closing, 105)) {
        if (!this.ensure(4.6)) break;
        this.add("closing", line, { font: 9, color: MUTED, height: 4.6 });
        this.y += 4.6;
      }
    }

    this.footer();
    return {
      template: {
        pdfmeVersion: PDFME_VERSION,
        basePdf: { width: W, height: H, padding: [0, 0, 0, 0] },
        schemas: this.pages,
      },
      inputs: [this.values],
      pages: this.pages.length,
      fieldCount: this.counter,
    };
  }

  private firstPageHeader() {
    this.rect("header_bg", 0, 0, W, 32, NAVY);
    this.absolute("sender_name", this.data.prepared_by || "Your name", {
      x: LEFT, y: 7, width: 120, height: 6, font: 12, color: WHITE, bold: true,
    });
    if (this.data.prepared_role) {
      this.absolute("sender_role", this.data.prepared_role, {
        x: LEFT, y: 13.2, width: 120, height: 5, font: 8.5, color: BLUE_SOFT,
      });
    }

    const contact = this.contactLines();
    if (contact.length) {
      this.absolute("sender_contact", contact.join("  ·  "), {
        x: LEFT, y: 20, width: 178, height: 9, font: 7.6, color: LIGHT, lineHeight: 1.25,
      });
    }
    this.absolute("proposal_badge", "PROPOSAL", {
      x: 148, y: 8, width: 46, height: 5, font: 8, color: "#93C5FD", align: "right",
    });

    this.y = 40;
    const titleLines = wrap(this.data.document_title || "Project proposal", 48).slice(0, 2);
    for (const line of titleLines) {
      this.absolute("document_title", line, {
        y: this.y, width: 178, height: 8, font: 18, color: NAVY_DARK, bold: true,
      });
      this.y += 8.4;
    }
    this.y += 1.5;
    for (const line of wrap(this.data.subtitle, 90).slice(0, 2)) {
      this.absolute("subtitle", line, { y: this.y, width: 178, height: 4.8, font: 9.3, color: MUTED });
      this.y += 4.8;
    }
    this.y += 5;
  }

  private clientAndDate() {
    const top = this.y;
    this.absolute("prepared_for_label", "PREPARED FOR", {
      x: LEFT, y: top, width: 95, height: 3.8, font: 6.8, color: MUTED, bold: true,
    });
    const client = this.data.prepared_for || "Hiring team";
    const clientLines = wrap(client, 48).slice(0, 2);
    clientLines.forEach((line, index) => {
      this.absolute("prepared_for", line, {
        x: LEFT, y: top + 4.6 + index * 4.4, width: 100, height: 4.4, font: 9.6, color: INK,
      });
    });

    const dateTop = top;
    this.absolute("date_label", "DATE", {
      x: 132, y: dateTop, width: 62, height: 3.8, font: 6.8, color: MUTED, bold: true, align: "right",
    });
    this.absolute("date", this.data.date || "", {
      x: 132, y: dateTop + 4.6, width: 62, height: 4.4, font: 9.2, color: INK, align: "right",
    });
    if (this.data.valid_until) {
      this.absolute("valid_until", `Valid until ${this.data.valid_until}`, {
        x: 122, y: dateTop + 9.2, width: 72, height: 3.8, font: 7.2, color: MUTED, align: "right",
      });
    }

    this.y = Math.max(top + 4.6 + clientLines.length * 4.4, top + 13) + 4;
    this.divider();
    this.y += 5;
  }

  private sectionHeading(title: string) {
    this.ensure(8);
    this.absolute("section_heading", title.toUpperCase(), {
      y: this.y, width: 178, height: 5.2, font: 10.2, color: NAVY, bold: true,
    });
    this.y += 6.2;
    this.line("section_rule", LEFT, this.y, 26, "#BFDBFE");
    this.y += 2.4;
  }

  private block(block: PpdBlock) {
    switch (block.type) {
      case "paragraph":
        for (const item of block.items) this.paragraph(item);
        break;
      case "note":
        this.paragraph(block.text, { color: MUTED, font: 9.2 });
        break;
      case "bullets":
        for (const item of block.items) this.bullet(item);
        this.y += 1.4;
        break;
      case "numberedSteps":
        block.items.forEach((step, index) => {
          if (this.full) return;
          this.ensure(13);
          this.absolute("step_title", `${String(index + 1).padStart(2, "0")}  ${step.title}`, {
            y: this.y, width: 170, height: 4.6, font: 9.6, color: NAVY_DARK, bold: true,
          });
          this.y += 5;
          this.paragraph(step.description, { font: 9.6, indent: 6 });
        });
        break;
      case "capabilityMatrix":
        this.keyValueTable(block.items.map((cap) => ({ label: cap.requirement, value: cap.approach })));
        break;
      case "keyValueTable":
        this.keyValueTable(block.rows);
        break;
      case "references":
        for (const ref of block.items) this.reference(ref.name, ref.url);
        break;
    }
  }

  private paragraph(value: string, opts: { font?: number; color?: string; indent?: number } = {}) {
    const font = opts.font ?? 9.8;
    const width = Math.floor((105 * 9.8) / font) - Math.round((opts.indent ?? 0) / 2);
    for (const line of wrap(value, Math.max(45, width))) {
      if (!this.ensure(4.8)) return;
      this.add("paragraph", line, {
        x: LEFT + (opts.indent ?? 0), width: CONTENT_W - (opts.indent ?? 0), height: 4.8,
        font, color: opts.color ?? INK, lineHeight: 1.3,
      });
      this.y += 4.8;
    }
    this.y += 1.8;
  }

  private bullet(value: string) {
    const width = 101;
    const lines = wrap(value, width);
    lines.forEach((line, index) => {
      if (!this.ensure(4.9)) return;
      if (index === 0) {
        this.absolute("bullet", "•", { x: LEFT, y: this.y, width: 4, height: 4.9, font: 9.8, color: NAVY });
      }
      this.add("bullet_text", line, {
        x: LEFT + 4.5, width: CONTENT_W - 4.5, height: 4.9, font: 9.7, color: INK, lineHeight: 1.3,
      });
      this.y += 4.9;
    });
    this.y += 1.2;
  }

  /** A table is one visual unit: never split its rows across a page break. */
  private keyValueTable(rows: Array<{ label: string; value: string }>) {
    const total = rows.reduce((sum, row) => sum + this.keyRowHeight(row.label, row.value) + 1.5, 0);
    if (!this.ensure(total)) return;
    for (const row of rows) this.keyRow(row.label, row.value);
  }

  private keyRowHeight(label: string, value: string) {
    const labelLines = wrap(label, 30);
    const valueLines = wrap(value, 67);
    return Math.max(labelLines.length, valueLines.length) * 4.7 + 3.4;
  }

  private keyRow(label: string, value: string) {
    const labelLines = wrap(label, 30);
    const valueLines = wrap(value, 67);
    const height = this.keyRowHeight(label, value);
    if (!this.ensure(height + 1.5)) return;
    const top = this.y;
    this.rect("table_shade", LEFT, top, CONTENT_W, height, SHADE);
    labelLines.forEach((line, index) => {
      this.absolute("table_key", line, {
        x: LEFT + 3, y: top + 1.7 + index * 4.7, width: 52, height: 4.7, font: 8.8, color: NAVY, bold: true,
      });
    });
    valueLines.forEach((line, index) => {
      this.absolute("table_value", line, {
        x: LEFT + 57, y: top + 1.7 + index * 4.7, width: 118, height: 4.7, font: 9.3, color: INK,
      });
    });
    this.y = top + height + 1.5;
  }

  /** Vertical room the first block needs before its section heading is written. */
  private blockMinimumHeight(block: PpdBlock): number {
    switch (block.type) {
      case "keyValueTable":
        return block.rows.reduce(
          (sum, row) => sum + this.keyRowHeight(row.label, row.value) + 1.5,
          0,
        );
      case "capabilityMatrix":
        return block.items.reduce(
          (sum, cap) => sum + this.keyRowHeight(cap.requirement, cap.approach) + 1.5,
          0,
        );
      case "bullets":
        return 12;
      case "numberedSteps":
        return 16;
      case "paragraph":
      case "note":
      case "references":
        return 10;
    }
  }

  private reference(name: string, url: string) {
    if (!this.ensure(8)) return;
    this.absolute("reference_name", name, { y: this.y, width: 178, height: 4.4, font: 9.4, color: NAVY_DARK, bold: true });
    this.y += 4.6;
    this.absolute("reference_url", url, { y: this.y, width: 178, height: 4, font: 8.4, color: NAVY });
    this.y += 5.4;
  }

  private divider() {
    this.ensure(1);
    this.line("divider", LEFT, this.y, CONTENT_W, LIGHT);
    this.y += 1;
  }

  private ensure(height: number): boolean {
    if (this.full) return false;
    if (this.y + height <= BOTTOM) return true;
    if (this.pages.length >= 2) {
      this.full = true;
      return false;
    }
    this.newPage();
    return true;
  }

  private newPage() {
    this.pages.push([]);
    this.y = 26;
    this.absolute("continuation_name", this.data.prepared_by || "Proposal", {
      x: LEFT, y: 12, width: 120, height: 4.4, font: 8.2, color: NAVY, bold: true,
    });
    this.absolute("continuation_label", "PROPOSAL · CONTINUED", {
      x: 110, y: 12, width: 84, height: 4.4, font: 7.4, color: MUTED, align: "right",
    });
    this.line("continuation_rule", LEFT, 18, CONTENT_W, LIGHT);
  }

  private footer() {
    const total = this.pages.length;
    this.pages.forEach((page, index) => {
      const footerY = 283;
      this.counter += 1;
      page.push({
        name: `footer_rule_${String(this.counter).padStart(4, "0")}`,
        type: "line",
        position: { x: LEFT, y: footerY },
        width: CONTENT_W,
        height: 0.3,
        color: LIGHT,
        readOnly: true,
      });
      const left = [this.data.prepared_by, this.data.prepared_role, this.data.sender_email]
        .filter(Boolean)
        .join("  ·  ");
      // `field()` only builds the schema. pdfme renders from `values[field.name]`,
      // so a footer pushed without an input is an invisible empty box.
      const identity = this.field("footer_identity", left, {
        x: LEFT, y: footerY + 2, width: 130, height: 4, font: 7, color: MUTED,
      });
      page.push(identity);
      this.values[identity.name] = left;
      const pageLabel = `Page ${index + 1} of ${total}`;
      const pageNumber = this.field("footer_page", pageLabel, {
        x: 148, y: footerY + 2, width: 46, height: 4, font: 7, color: MUTED, align: "right",
      });
      page.push(pageNumber);
      this.values[pageNumber.name] = pageLabel;
    });
  }

  private contactLines(): string[] {
    const line1 = [this.data.sender_email, this.data.sender_phone, this.data.sender_whatsapp]
      .filter(Boolean)
      .join("  ·  ");
    const line2 = [this.data.sender_linkedin, this.data.sender_website, this.data.sender_location]
      .filter(Boolean)
      .join("  ·  ");
    return [line1, line2].filter(Boolean);
  }

  private absolute(name: string, content: string, opts: AddOptions & { y: number; x?: number }) {
    const page = this.pages[this.pages.length - 1];
    if (!page) return;
    const field = this.field(name, content, opts);
    page.push(field);
    this.values[field.name] = String(content);
  }

  private add(name: string, content: string, opts: AddOptions = {}) {
    this.absoluteAtPage(this.pages.length - 1, name, content, opts);
  }

  private absoluteAtPage(pageIndex: number, name: string, content: string, opts: AddOptions = {}) {
    const page = this.pages[pageIndex];
    if (!page) return;
    const field = this.field(name, content, opts);
    page.push(field);
    this.values[field.name] = String(content);
  }

  private line(name: string, x: number, y: number, width: number, color: string) {
    this.counter += 1;
    const key = `${name}_${String(this.counter).padStart(4, "0")}`;
    const page = this.pages[this.pages.length - 1];
    if (!page) return;
    page.push({
      name: key,
      type: "line",
      position: { x: round2(x), y: round2(y) },
      width: round2(width),
      height: 0.3,
      color,
      readOnly: true,
    });
  }

  private rect(name: string, x: number, y: number, width: number, height: number, color: string) {
    this.counter += 1;
    const key = `${name}_${String(this.counter).padStart(4, "0")}`;
    const page = this.pages[this.pages.length - 1];
    if (!page) return;
    page.push({
      name: key,
      type: "rectangle",
      position: { x: round2(x), y: round2(y) },
      width: round2(width),
      height: round2(height),
      color,
      borderColor: color,
      borderWidth: 0,
      readOnly: true,
    });
  }

  private field(name: string, content: string, opts: AddOptions & { y?: number }): PdfmeField {
    this.counter += 1;
    const font = opts.font ?? 10;
    return {
      name: `${name}_${String(this.counter).padStart(4, "0")}`,
      type: "text",
      position: { x: round2(opts.x ?? LEFT), y: round2(opts.y ?? this.y) },
      width: round2(opts.width ?? CONTENT_W),
      height: round2(opts.height ?? 5),
      content: String(content),
      fontName: opts.bold ? "SourceSans3Semibold" : "SourceSans3",
      fontSize: font,
      fontColor: opts.color ?? INK,
      backgroundColor: opts.background ?? "",
      verticalAlignment: "top",
      alignment: opts.align ?? "left",
      lineHeight: opts.lineHeight ?? 1.25,
      readOnly: false,
      required: false,
      dynamicFontSize: { min: Math.max(6, font - 2), max: font, fit: "vertical" },
    };
  }
}

export function compileProposalPdfme(
  input: ProposalPpd | LegacyProposalPpd | Record<string, unknown> | null | undefined,
): CompiledProposalPdfme {
  return new ProposalBuilder(toBlockPpd(input)).build();
}

export const PAGE_METRICS = { width: W, height: H, left: LEFT, top: TOP, bottom: BOTTOM };

/* ────────────────────────────── helpers ────────────────────────────── */

function blockHasContent(block: PpdBlock): boolean {
  switch (block.type) {
    case "paragraph":
    case "bullets":
      return block.items.some((item) => item.trim().length > 0);
    case "note":
      return block.text.trim().length > 0;
    case "numberedSteps":
      return block.items.some((item) => item.title.trim() || item.description.trim());
    case "capabilityMatrix":
      return block.items.some((item) => item.requirement.trim() || item.approach.trim());
    case "keyValueTable":
      return block.rows.some((row) => row.label.trim() || row.value.trim());
    case "references":
      return block.items.length > 0;
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

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Legacy flat PPD → the current contract, so documents written before the
 * sender-profile change still render (with no company branding).
 */
function toBlockPpd(input: unknown): ProposalPpd {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (Array.isArray(raw.sections)) return normalizeBlockPpd(raw);

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
  push("approach", "Approach", legacy.approach?.length ? [{ type: "bullets", items: legacy.approach }] : []);
  push("why-us", "Why work with me", legacy.why_us?.length ? [{ type: "bullets", items: legacy.why_us }] : []);

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
    String(legacy.pricing_title ?? "") || "Timeline & investment",
    terms.length ? [{ type: "keyValueTable", rows: terms }] : [],
  );

  const extras = [...(legacy.includes ?? []), ...(legacy.assumptions ?? [])];
  push("inclusions", "What is included & assumptions", extras.length ? [{ type: "bullets", items: extras }] : []);
  push(
    "next-steps",
    "Next steps",
    legacy.next_steps?.length ? [{ type: "bullets", items: legacy.next_steps }] : [],
  );
  push("note", "", legacy.footer_note ? [{ type: "note", text: legacy.footer_note }] : []);

  return normalizeBlockPpd({
    document_title: String(legacy.document_title ?? "Project proposal"),
    subtitle: String(legacy.proposal_subtitle ?? ""),
    job_title: String(raw.job_title ?? ""),
    job_reference: String(raw.job_reference ?? ""),
    prepared_for: String(raw.prepared_for ?? ""),
    prepared_by: String(raw.prepared_by ?? raw.contact_name_signature ?? ""),
    prepared_role: String(raw.prepared_role ?? raw.prepared_title ?? ""),
    sender_email: String(raw.sender_email ?? raw.contact_email ?? ""),
    sender_phone: String(raw.sender_phone ?? raw.contact_phone ?? ""),
    sender_whatsapp: String(raw.sender_whatsapp ?? ""),
    sender_linkedin: String(raw.sender_linkedin ?? ""),
    sender_website: String(raw.sender_website ?? raw.website ?? ""),
    sender_location: String(raw.sender_location ?? ""),
    date: String(raw.date ?? raw.today ?? ""),
    valid_until: String(raw.valid_until ?? ""),
    rate: String(raw.rate ?? ""),
    engagement: String(raw.engagement ?? ""),
    sections,
    closing: String(legacy.closing_note ?? ""),
  });
}

function normalizeBlockPpd(raw: Record<string, unknown>): ProposalPpd {
  return {
    document_title: String(raw.document_title ?? "Project proposal"),
    subtitle: String(raw.subtitle ?? ""),
    prepared_for: String(raw.prepared_for ?? ""),
    prepared_by: String(raw.prepared_by ?? ""),
    prepared_role: String(raw.prepared_role ?? ""),
    sender_email: String(raw.sender_email ?? ""),
    sender_phone: String(raw.sender_phone ?? ""),
    sender_whatsapp: String(raw.sender_whatsapp ?? ""),
    sender_linkedin: String(raw.sender_linkedin ?? ""),
    sender_website: String(raw.sender_website ?? raw.website ?? ""),
    sender_location: String(raw.sender_location ?? ""),
    date: String(raw.date ?? ""),
    valid_until: String(raw.valid_until ?? ""),
    job_title: String(raw.job_title ?? ""),
    job_reference: String(raw.job_reference ?? ""),
    rate: String(raw.rate ?? ""),
    engagement: String(raw.engagement ?? ""),
    sections: Array.isArray(raw.sections) ? (raw.sections as PpdSection[]) : [],
    closing: String(raw.closing ?? ""),
  };
}
