"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Copy-to-clipboard chip for anything a human pastes elsewhere: an email
 * address, a job id, a subject line, a curl snippet.
 *
 * `navigator.clipboard` needs a secure context, so a hidden-textarea fallback
 * keeps it working over plain http://localhost and in older Safari.
 */
export function CopyButton({
  value,
  label = "Copy",
  copiedLabel = "Copied",
  className,
  size = "sm",
}: {
  value: string;
  label?: string;
  copiedLabel?: string;
  className?: string;
  size?: "sm" | "icon";
}) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1_800);
    return () => clearTimeout(timer);
  }, [state]);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      } else {
        throw new Error("no clipboard api");
      }
    } catch {
      ok = legacyCopy(value);
    }
    setState(ok ? "ok" : "fail");
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={size === "icon" ? label : undefined}
      aria-label={`${label} ${size === "icon" ? value : ""}`.trim()}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1 rounded-md border border-line bg-surface-2/60 font-medium text-muted transition hover:border-brand/60 hover:text-ink focus-ring",
        size === "icon" ? "h-6 w-6 text-[11px]" : "h-6 px-2 text-[11px]",
        state === "ok" && "border-brand/50 text-brand",
        state === "fail" && "border-danger/50 text-danger",
        className,
      )}
    >
      {state === "ok" ? "✓" : state === "fail" ? "✕" : size === "icon" ? "⧉" : null}
      {size === "sm" ? (
        <span>{state === "ok" ? copiedLabel : state === "fail" ? "Press ⌘C" : label}</span>
      ) : null}
    </button>
  );
}

function legacyCopy(value: string) {
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/** Inline copy chip next to a value: `hello@x.com ⧉` */
export function Copyable({
  value,
  children,
  className,
}: {
  value: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span className="min-w-0 truncate">{children ?? value}</span>
      <CopyButton value={value} size="icon" label={`Copy ${value}`} />
    </span>
  );
}
