"use client";

import { useEffect, useState } from "react";
import { useRenderPdf } from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

/**
 * In-dashboard PDF preview.
 *
 * "Preview" is the only place a PDF appears during review: it is compiled by
 * PDFme from the *reviewed* PPD on this click (or on send), never by the model
 * and never before a human approved the text. Fetched as a blob so the
 * authenticated route works inside an <iframe>, which cannot send headers.
 */
export function PdfViewerModal({
  open,
  onClose,
  leadId,
  proposalId,
  title = "Proposal PDF",
}: {
  open: boolean;
  onClose: () => void;
  leadId: string;
  proposalId?: string | null;
  title?: string;
}) {
  const render = useRenderPdf(leadId);
  const [url, setUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    render.reset();
    render.mutate({ proposalId: proposalId ?? undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, proposalId]);

  useEffect(() => {
    const blob = render.data?.blob;
    if (!blob) return;
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    setFilename(render.data?.filename ?? "proposal.pdf");
    return () => URL.revokeObjectURL(objectUrl);
  }, [render.data]);

  useEffect(() => {
    if (open) return;
    setUrl(null);
  }, [open]);

  const busy = render.isPending || (!url && !render.error);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description="Compiled by PDFme from the reviewed PPD at this moment. Editing the document again marks it stale and the next render uses the new text."
      className="max-w-4xl"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={render.isPending}
            onClick={() => {
              setUrl(null);
              render.mutate({ proposalId: proposalId ?? undefined, download: true });
            }}
          >
            Re-render
          </Button>
          <a
            href={url ?? undefined}
            download={filename ?? "proposal.pdf"}
            aria-disabled={!url}
            className={cn(
              "inline-flex h-8 items-center gap-2 rounded-lg px-3 text-xs font-medium transition focus-ring",
              url
                ? "bg-brand text-brand-ink hover:brightness-110"
                : "cursor-not-allowed bg-surface-2 text-muted opacity-60",
            )}
          >
            Download
          </a>
        </>
      }
    >
      <div className="h-[68vh] overflow-hidden rounded-lg border border-line bg-canvas">
        {render.error ? (
          <EmptyState
            tone="danger"
            icon="✕"
            title="This PDF could not be rendered"
            description={render.error.message}
          />
        ) : busy ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted">
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            Compiling pages from the reviewed document…
          </div>
        ) : url ? (
          <iframe
            title="Proposal PDF preview"
            src={url}
            className="h-full w-full"
            referrerPolicy="no-referrer"
          />
        ) : null}
      </div>
    </Modal>
  );
}
