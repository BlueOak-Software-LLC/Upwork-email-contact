"use client";

import { CopyButton } from "./copy-button";
import { cn } from "@/lib/utils";

/**
 * Monospace block with a copy affordance. Used for curl samples and response
 * shapes on /api-docs, where reading is never the hard part — retyping is.
 */
export function CodeBlock({
  code,
  label = "Copy",
  title,
  className,
  collapseAt,
}: {
  code: string;
  label?: string;
  title?: string;
  className?: string;
  /** Lines to show before the block collapses behind a toggle. */
  collapseAt?: number;
}) {
  const lines = code.split("\n");
  const collapsible = collapseAt !== undefined && lines.length > collapseAt;

  const body = (
    <pre
      className={cn(
        "overflow-x-auto rounded-lg bg-canvas p-3 text-[11px] leading-relaxed text-muted",
        collapsible && "mt-2",
        className,
      )}
    >
      {code}
    </pre>
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {title ? <span className="text-[11px] text-muted/70">{title}</span> : <span />}
        <CopyButton value={code} label={label} />
      </div>
      {collapsible ? (
        <details open={false}>
          <summary className="cursor-pointer text-[11px] text-brand/80 hover:text-brand">
            {lines.length} lines — show / hide
          </summary>
          {body}
        </details>
      ) : (
        body
      )}
    </div>
  );
}
