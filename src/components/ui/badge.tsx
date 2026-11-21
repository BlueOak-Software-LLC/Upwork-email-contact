import { cn } from "./cn";

const tones = {
  neutral: "bg-surface-2 text-muted border-line",
  brand: "bg-brand/12 text-brand border-brand/35",
  warn: "bg-warn/12 text-warn border-warn/35",
  danger: "bg-danger/12 text-danger border-danger/35",
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
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  new: "brand",
  contacted: "warn",
  replied: "brand",
  no_reply: "neutral",
  archived: "neutral",
  sent: "brand",
  queued: "warn",
  failed: "danger",
  bounced: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replace("_", " ")}</Badge>;
}
