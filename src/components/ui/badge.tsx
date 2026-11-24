import { cn } from "./cn";

const tones = {
  neutral: "bg-surface-2 text-muted border-line-soft",
  brand: "bg-brand/12 text-brand border-brand/35",
  info: "bg-info/12 text-info border-info/30",
  warn: "bg-warn/12 text-warn border-warn/35",
  danger: "bg-danger/14 text-danger border-danger/40",
} as const;

export type Tone = keyof typeof tones;

export function Badge({
  tone = "neutral",
  className,
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * Colour means "what do I do with this row": sky = informational, amber =
 * waiting on you, mint = moving forward, rose = broken, grey = inert.
 */
const STATUS_TONE: Record<string, Tone> = {
  // lead pipeline
  received: "info",
  awaiting_generation: "neutral",
  proposal_ready: "warn", // a document nobody has read yet is the next task
  enriched: "warn",
  draft_created: "brand",
  sent: "brand",
  contacted: "warn",
  replied: "brand",
  no_reply: "neutral",
  archived: "neutral",
  error: "danger",
  // draft / delivery states
  new: "info",
  draft: "info",
  queued: "warn",
  sending: "info",
  failed: "danger",
  bounced: "danger",
  cancelled: "neutral",
};

/** Status tokens arrive as `proposal_ready`; only these get title-cased. */
export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} className="capitalize">
      {status.replace(/_/g, " ")}
    </Badge>
  );
}
