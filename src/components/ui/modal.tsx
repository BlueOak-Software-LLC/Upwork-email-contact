"use client";

import { useEffect, useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Dependency-free modal: native <dialog> would be fine too, but this keeps
 * focus trapping + Escape handling explicit and easy to theme.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className={cn("card w-full max-w-lg p-5 shadow-2xl", className)}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h3 id={`${id}-title`} className="text-base font-semibold">
              {title}
            </h3>
            {description ? (
              <p className="mt-1 text-sm text-muted">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-ink focus-ring"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">{children}</div>

        {footer ? (
          <div className="mt-5 flex justify-end gap-2">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
