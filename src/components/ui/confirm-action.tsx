"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

/**
 * Destructive actions get one consistent path: a labelled button, then a modal
 * that repeats what is about to disappear. `window.confirm()` is deliberately
 * avoided — it is unstyleable, blocks the tab, and gets silently suppressed by
 * some browsers once a page trains users to dismiss it.
 */
export function ConfirmAction({
  label,
  confirmLabel = "Yes, continue",
  title,
  description,
  onConfirm,
  busy,
  variant = "danger",
  size = "sm",
}: {
  label: string;
  confirmLabel?: string;
  title: string;
  description: string;
  onConfirm: () => void;
  busy?: boolean;
  variant?: "danger" | "primary";
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        size={size}
        variant="ghost"
        className={variant === "danger" ? "text-danger hover:bg-danger/10" : undefined}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={variant}
              loading={busy}
              onClick={() => {
                onConfirm();
                setOpen(false);
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        <p className="text-xs text-muted">
          This cannot be undone from the dashboard. Rows cascade where the database defines them.
        </p>
      </Modal>
    </>
  );
}
