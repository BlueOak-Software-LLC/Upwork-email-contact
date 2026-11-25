"use client";

import { useState } from "react";
import type { PpdBlock, PpdBlockType, ProposalPpd, PpdSection } from "@/types/lead";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";

/**
 * Structured editor for a PPD: every block the document compiler understands
 * gets real inputs instead of a JSON wall.
 *
 * The parent owns the draft object, so the reviewer can move between Read /
 * Edit / JSON with one unsaved copy, and nothing is persisted until Save.
 *
 * Identity fields are locked here on purpose — they come from the sender
 * profile, and `sanitizeEditedPpd()` re-applies them even if a client sent
 * something else, so the UI refuses to imply they are editable.
 */
export const LOCKED_FIELDS: ReadonlyArray<keyof ProposalPpd> = [
  "prepared_by",
  "prepared_role",
  "sender_email",
  "sender_phone",
  "sender_whatsapp",
  "sender_linkedin",
  "sender_website",
  "sender_location",
  "date",
  "valid_until",
  "job_title",
  "job_reference",
];

const BLOCK_LABEL: Record<PpdBlockType, string> = {
  paragraph: "Paragraphs",
  bullets: "Bullet list",
  numberedSteps: "Numbered steps",
  capabilityMatrix: "Requirement → approach",
  keyValueTable: "Label / value table",
  note: "Note / callout",
  references: "References (locked)",
};

const ADDABLE: PpdBlockType[] = [
  "paragraph",
  "bullets",
  "numberedSteps",
  "capabilityMatrix",
  "keyValueTable",
  "note",
];

export function ppdWordCount(ppd: ProposalPpd | null): number {
  if (!ppd) return 0;
  const parts: string[] = [ppd.document_title, ppd.subtitle, ppd.closing];
  for (const section of ppd.sections ?? []) {
    parts.push(section.title ?? "");
    for (const block of section.blocks ?? []) parts.push(...blockStrings(block));
  }
  return parts.join(" ").split(/\s+/).filter(Boolean).length;
}

/**
 * The same limits `proposal-sanitize.ts` enforces, so a reviewer sees before
 * saving what the server will clip or drop — nothing should disappear silently.
 */
const EDIT_CAPS = {
  paragraph: 1400,
  bullet: 400,
  stepTitle: 120,
  stepDescription: 900,
  requirement: 140,
  approach: 600,
  label: 80,
  value: 600,
  blocksPerSection: 10,
  itemsPerBlock: 20,
  sections: 14,
} as const;

export function ppdEditIssues(ppd: ProposalPpd | null): string[] {
  if (!ppd) return ["there is no document to save"];
  const issues: string[] = [];
  const sections = ppd.sections ?? [];

  if (sections.length > EDIT_CAPS.sections) {
    issues.push(`only the first ${EDIT_CAPS.sections} sections are kept`);
  }

  for (const section of sections) {
    const label = `“${section.title || section.id}”`;
    const blocks = section.blocks ?? [];

    if (!blocks.length) {
      issues.push(`${label} has no blocks and will be dropped`);
      continue;
    }
    if (blocks.length > EDIT_CAPS.blocksPerSection) {
      issues.push(`${label} keeps only its first ${EDIT_CAPS.blocksPerSection} blocks`);
    }

    blocks.forEach((block, blockIndex) => {
      const where = `${label} block ${blockIndex + 1} (${block.type})`;

      if (block.type === "note") {
        if (!block.text.trim()) issues.push(`${where} is empty and will be dropped`);
        return;
      }

      if (block.type === "references") {
        if (block.items.length) {
          issues.push(`${where}: references are server-controlled, unverified links are dropped`);
        }
        return;
      }

      const fields = blockFields(block);
      const isEmpty = !fields.some(([text]) => text.trim());
      const empties =
        block.type === "paragraph" || block.type === "bullets"
          ? block.items.filter((item) => !item.trim()).length
          : 0;
      if (isEmpty) {
        issues.push(`${where} has no text and will be dropped`);
      } else if (empties) {
        issues.push(`${where}: ${empties} empty line(s) will be removed`);
      }

      const over = fields.filter(([text, cap]) => text.length > cap * 1.6);
      if (over.length) {
        issues.push(`${where}: ${over.length} line(s) over the compiler’s length cap will be clipped`);
      }
    });
  }

  return issues.slice(0, 8);
}

/** Every text field in a block paired with the cap the server applies to it. */
function blockFields(block: PpdBlock): Array<[string, number]> {
  switch (block.type) {
    case "paragraph":
      return block.items.map((item) => [item, EDIT_CAPS.paragraph]);
    case "bullets":
      return block.items.map((item) => [item, EDIT_CAPS.bullet]);
    case "note":
      return [[block.text, EDIT_CAPS.paragraph]];
    case "numberedSteps":
      return block.items.flatMap((item) => [
        [item.title, EDIT_CAPS.stepTitle],
        [item.description, EDIT_CAPS.stepDescription],
      ] as Array<[string, number]>);
    case "capabilityMatrix":
      return block.items.flatMap((item) => [
        [item.requirement, EDIT_CAPS.requirement],
        [item.approach, EDIT_CAPS.approach],
      ] as Array<[string, number]>);
    case "keyValueTable":
      return block.rows.flatMap((row) => [
        [row.label, EDIT_CAPS.label],
        [row.value, EDIT_CAPS.value],
      ] as Array<[string, number]>);
    case "references":
      return block.items.map((item) => [item.url, 300]);
  }
}

function blockStrings(block: PpdBlock): string[] {
  switch (block.type) {
    case "paragraph":
    case "bullets":
      return block.items;
    case "note":
      return [block.text];
    case "numberedSteps":
      return block.items.flatMap((i) => [i.title, i.description]);
    case "capabilityMatrix":
      return block.items.flatMap((i) => [i.requirement, i.approach]);
    case "keyValueTable":
      return block.rows.flatMap((r) => [r.label, r.value]);
    case "references":
      return block.items.map((r) => `${r.name} ${r.url}`);
  }
}

function emptyBlock(type: PpdBlockType): PpdBlock {
  switch (type) {
    case "paragraph":
      return { type, items: [""] };
    case "bullets":
      return { type, items: [""] };
    case "note":
      return { type, text: "" };
    case "numberedSteps":
      return { type, items: [{ title: "", description: "" }] };
    case "capabilityMatrix":
      return { type, items: [{ requirement: "", approach: "" }] };
    case "keyValueTable":
      return { type, rows: [{ label: "", value: "" }] };
    case "references":
      return { type, items: [] };
  }
}

export function PpdEditor({
  ppd,
  onChange,
}: {
  ppd: ProposalPpd;
  onChange: (next: ProposalPpd) => void;
}) {
  const [openSection, setOpenSection] = useState<string | null>(ppd.sections?.[0]?.id ?? null);

  const patch = (part: Partial<ProposalPpd>) => onChange({ ...ppd, ...part });

  const editSection = (index: number, next: PpdSection) => {
    const sections = [...(ppd.sections ?? [])];
    sections[index] = next;
    patch({ sections });
  };

  const moveSection = (index: number, delta: number) => {
    const sections = [...(ppd.sections ?? [])];
    const target = index + delta;
    const row = sections[index];
    if (!row || target < 0 || target >= sections.length) return;
    sections.splice(index, 1);
    sections.splice(target, 0, row);
    patch({ sections });
  };

  const lockedMeta = LOCKED_FIELDS.map((key) => [key, ppd[key] ?? ""] as const).filter(
    ([, value]) => String(value).trim().length > 0,
  );

  return (
    <div className="space-y-4">
      {/* ── editable identity of the document ─────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2">
        <MetaField
          label="Document title"
          value={ppd.document_title}
          onChange={(value) => patch({ document_title: value })}
        />
        <MetaField
          label="Subtitle"
          value={ppd.subtitle}
          onChange={(value) => patch({ subtitle: value })}
        />
        <MetaField
          label="Prepared for"
          value={ppd.prepared_for}
          onChange={(value) => patch({ prepared_for: value })}
        />
        <MetaField
          label="Proposed rate"
          value={ppd.rate}
          placeholder="indicative — confirmed after a short scoping call"
          onChange={(value) => patch({ rate: value })}
        />
        <MetaField
          label="Engagement"
          value={ppd.engagement}
          onChange={(value) => patch({ engagement: value })}
        />
        <div className="sm:col-span-2">
          <MetaField
            label="Closing line"
            value={ppd.closing}
            multiline
            onChange={(value) => patch({ closing: value })}
          />
        </div>
      </div>

      {lockedMeta.length ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-canvas px-3 py-2 text-[11px] text-muted">
          <span className="font-medium text-ink">🔒 From your sender profile</span>
          {lockedMeta.map(([key, value]) => (
            <span key={key as string} className="truncate">
              {String(key).replace(/_/g, " ")}: <span className="text-ink/80">{String(value)}</span>
            </span>
          ))}
          <span className="text-muted/70">
            — edit <code>Settings → Senders &amp; profile</code>, not the document
          </span>
        </div>
      ) : null}

      {/* ── sections ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted">
            Sections ({ppd.sections?.length ?? 0})
          </h4>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const id = `section_${Date.now().toString(36).slice(-4)}`;
              patch({
                sections: [
                  ...(ppd.sections ?? []),
                  { id, title: "New section", blocks: [{ type: "paragraph", items: [""] }] },
                ],
              });
              setOpenSection(id);
            }}
          >
            + Section
          </Button>
        </div>

        {(ppd.sections ?? []).map((section, index) => {
          const open = openSection === section.id;
          return (
            <div key={section.id} className="rounded-lg border border-line bg-canvas/60">
              <div className="flex items-center gap-2 p-2">
                <button
                  type="button"
                  onClick={() => setOpenSection(open ? null : section.id)}
                  aria-expanded={open}
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-xs text-muted transition hover:bg-surface-2 hover:text-ink focus-ring"
                >
                  {open ? "▾" : "▸"}
                </button>
                <input
                  value={section.title ?? ""}
                  onChange={(e) => editSection(index, { ...section, title: e.target.value })}
                  aria-label={`Section ${index + 1} title`}
                  className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium transition hover:border-line focus:border-brand/60 focus:bg-surface focus-ring"
                />
                <span className="shrink-0 text-[11px] text-muted tabular">
                  {(section.blocks ?? []).length} block(s)
                </span>
                <RowMove
                  onUp={() => moveSection(index, -1)}
                  onDown={() => moveSection(index, 1)}
                  onRemove={() =>
                    patch({ sections: (ppd.sections ?? []).filter((_, i) => i !== index) })
                  }
                />
              </div>

              {open ? (
                <div className="space-y-3 border-t border-line p-3">
                  {(section.blocks ?? []).map((block, blockIndex) => (
                    <BlockEditor
                      key={blockIndex}
                      block={block}
                      onChange={(next) =>
                        editSection(index, {
                          ...section,
                          blocks: section.blocks.map((b, i) => (i === blockIndex ? next : b)),
                        })
                      }
                      onRemove={() =>
                        editSection(index, {
                          ...section,
                          blocks: section.blocks.filter((_, i) => i !== blockIndex),
                        })
                      }
                      onMove={(delta) => {
                        const blocks = [...section.blocks];
                        const target = blockIndex + delta;
                        const row = blocks[blockIndex];
                        if (!row || target < 0 || target >= blocks.length) return;
                        blocks.splice(blockIndex, 1);
                        blocks.splice(target, 0, row);
                        editSection(index, { ...section, blocks });
                      }}
                    />
                  ))}

                  <AddBlockRow
                    onAdd={(type) =>
                      editSection(index, {
                        ...section,
                        blocks: [...(section.blocks ?? []), emptyBlock(type)],
                      })
                    }
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-canvas px-3 py-2 text-[11px] text-muted">
        <span className="tabular">{ppdWordCount(ppd)} words</span>
        <span>·</span>
        <span>
          {(ppd.sections ?? []).reduce((sum, s) => sum + (s.blocks?.length ?? 0), 0)} blocks across{" "}
          {(ppd.sections ?? []).length} sections
        </span>
        <span className="ml-auto flex items-center gap-1">
          Copy this document as JSON
          <CopyButton value={JSON.stringify(ppd, null, 2)} size="icon" label="Copy PPD JSON" />
        </span>
      </div>
    </div>
  );
}

/* ───────────────────────────── building blocks ──────────────────────────── */

function MetaField({
  label,
  value,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      {multiline ? (
        <Textarea rows={2} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}

function RowMove({
  onUp,
  onDown,
  onRemove,
  disableUp,
  disableDown,
}: {
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
  disableUp?: boolean;
  disableDown?: boolean;
}) {
  const cls =
    "grid h-6 w-6 place-items-center rounded text-[11px] text-muted transition hover:bg-surface-2 hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus-ring";
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <button type="button" className={cls} onClick={onUp} disabled={disableUp} aria-label="Move up">
        ↑
      </button>
      <button
        type="button"
        className={cls}
        onClick={onDown}
        disabled={disableDown}
        aria-label="Move down"
      >
        ↓
      </button>
      <button
        type="button"
        className={cn(cls, "hover:text-danger")}
        onClick={onRemove}
        aria-label="Remove"
      >
        ✕
      </button>
    </span>
  );
}

function AddBlockRow({ onAdd }: { onAdd: (type: PpdBlockType) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="text-[11px] text-muted">add block:</span>
      {ADDABLE.map((type) => (
        <button
          key={type}
          type="button"
          onClick={() => onAdd(type)}
          className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted transition hover:border-brand/60 hover:text-ink focus-ring"
        >
          + {BLOCK_LABEL[type]}
        </button>
      ))}
    </div>
  );
}

function BlockShell({
  type,
  children,
  onRemove,
  onMove,
}: {
  type: PpdBlockType;
  children: React.ReactNode;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
          {BLOCK_LABEL[type]}
        </span>
        <RowMove onUp={() => onMove(-1)} onDown={() => onMove(1)} onRemove={onRemove} />
      </div>
      {children}
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
  onRemove,
  onMove,
}: {
  block: PpdBlock;
  onChange: (block: PpdBlock) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const shell = (children: React.ReactNode) => (
    <BlockShell type={block.type} onRemove={onRemove} onMove={onMove}>
      {children}
    </BlockShell>
  );

  if (block.type === "note") {
    return shell(
      <Textarea
        rows={2}
        value={block.text}
        aria-label="Note text"
        onChange={(e) => onChange({ ...block, text: e.target.value })}
      />,
    );
  }

  if (block.type === "paragraph" || block.type === "bullets") {
    const list = block.items;
    return shell(
      <StringList
        ordered={block.type === "bullets"}
        values={list}
        onChange={(values) => onChange({ ...block, items: values } as PpdBlock)}
      />
    );
  }

  if (block.type === "numberedSteps") {
    return shell(
      <PairRows
        rows={block.items.map((i) => [i.title, i.description] as [string, string])}
        leftLabel="Step"
        rightLabel="Detail"
        onChange={(rows) =>
          onChange({ ...block, items: rows.map(([title, description]) => ({ title, description })) })
        }
      />
    );
  }

  if (block.type === "capabilityMatrix") {
    return shell(
      <PairRows
        rows={block.items.map((i) => [i.requirement, i.approach] as [string, string])}
        leftLabel="Requirement from the post"
        rightLabel="How we meet it"
        onChange={(rows) =>
          onChange({
            ...block,
            items: rows.map(([requirement, approach]) => ({ requirement, approach })),
          })
        }
      />
    );
  }

  if (block.type === "keyValueTable") {
    return shell(
      <PairRows
        rows={block.rows.map((r) => [r.label, r.value] as [string, string])}
        leftLabel="Label"
        rightLabel="Value"
        onChange={(rows) =>
          onChange({ ...block, rows: rows.map(([label, value]) => ({ label, value })) })
        }
      />
    );
  }

  // references: the server keeps only vetted ones, so this is display-only.
  return shell(
    <div className="space-y-2 text-xs text-muted">
      {block.items.length ? (
        <ul className="space-y-1">
          {block.items.map((item, index) => (
            <li key={index} className="rounded bg-canvas p-2">
              {item.name} — {item.url}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No verified references are configured, so the compiler prints none here. The model cannot
          add links: anything it invents is dropped by{" "}
          <code>sanitizePpd(verifiedReferences: [])</code>.
        </p>
      )}
    </div>
  );
}

function StringList({
  values,
  onChange,
  ordered,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  ordered?: boolean;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    const row = values[index];
    if (row === undefined || target < 0 || target >= values.length) return;
    const next = [...values];
    next.splice(index, 1);
    next.splice(target, 0, row);
    onChange(next);
  };

  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={index} className="flex items-start gap-2">
          <span className="mt-2.5 w-4 shrink-0 text-center text-[11px] text-muted tabular">
            {ordered ? "•" : index + 1}
          </span>
          <Textarea
            rows={2}
            value={value}
            aria-label={`Line ${index + 1}`}
            onChange={(e) => onChange(values.map((v, i) => (i === index ? e.target.value : v)))}
            className="flex-1"
          />
          <RowMove
            onUp={() => move(index, -1)}
            onDown={() => move(index, 1)}
            onRemove={() => onChange(values.filter((_, i) => i !== index))}
          />
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...values, ""])}>
        + Line
      </Button>
    </div>
  );
}

/**
 * Two-field rows (step/detail, requirement/approach, label/value). Tuples in,
 * tuples out: each block type maps to its own field names, so the editor never
 * has to invent keys on a typed object.
 */
function PairRows({
  rows,
  leftLabel,
  rightLabel,
  onChange,
}: {
  rows: Array<[string, string]>;
  leftLabel: string;
  rightLabel: string;
  onChange: (rows: Array<[string, string]>) => void;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    const row = rows[index];
    if (!row || target < 0 || target >= rows.length) return;
    const next = [...rows];
    next.splice(index, 1);
    next.splice(target, 0, row);
    onChange(next);
  };

  const setCell = (index: number, side: 0 | 1, value: string) =>
    onChange(rows.map((row, i) => (i === index ? ([side === 0 ? value : row[0], side === 1 ? value : row[1]] as [string, string]) : row)));

  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="rounded-lg border border-line/70 bg-canvas p-2">
          <div className="flex items-start gap-2">
            <label className="min-w-0 flex-1 space-y-1">
              <span className="text-[10px] uppercase tracking-wide text-muted">{leftLabel}</span>
              <Input value={row[0]} onChange={(e) => setCell(index, 0, e.target.value)} />
            </label>
            <RowMove
              onUp={() => move(index, -1)}
              onDown={() => move(index, 1)}
              onRemove={() => onChange(rows.filter((_, i) => i !== index))}
            />
          </div>
          <label className="mt-2 block space-y-1">
            <span className="text-[10px] uppercase tracking-wide text-muted">{rightLabel}</span>
            <Textarea
              rows={2}
              value={row[1]}
              onChange={(e) => setCell(index, 1, e.target.value)}
            />
          </label>
        </div>
      ))}
      <Button size="sm" variant="ghost" onClick={() => onChange([...rows, ["", ""]])}>
        + Row
      </Button>
    </div>
  );
}
