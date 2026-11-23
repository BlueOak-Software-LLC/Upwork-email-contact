"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useIngestLead } from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Select } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/errors";

/**
 * Paste a scraper payload straight into POST /api/leads.
 *
 * Exists for testing and recovery: the body is sent exactly as pasted, so the
 * dedupe, contact extraction and (optionally) document generation behave the
 * same as they do for the real scraper.
 */
const BLANK = `{
  "job_information": {
    "job_id": null,
    "job_title": null,
    "job_description": "",
    "job_url": null,
    "industry": null,
    "job_location": null,
    "company_mentioned": null
  },
  "upwork_client": { "client_name": null, "location": null },
  "key_people": [],
  "contact_information": {
    "verified_contacts": [],
    "potential_contacts": []
  },
  "overall_confidence": ""
}`;

const DESCRIPTION_ONLY = `{
  "job_information": {
    "job_description": "We need a 30-second logo sting animation for a manufacturing conference. After Effects, vector source file, loop-friendly, MP4 plus transparent mov."
  }
}`;

export function IngestDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const ingest = useIngestLead();
  const [text, setText] = useState(BLANK);
  const [auto, setAuto] = useState("");

  const parsed = (() => {
    try {
      const value = JSON.parse(text) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false as const, message: "The body must be a JSON object" };
      }
      return { ok: true as const, value: value as Record<string, unknown> };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
  })();

  // Ingest is usually instant, but with AUTO_ENRICH_LEADS the document is
  // written inside this same request (30-60 s), so the wait is explained rather
  // than looking like a frozen dialog.
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (ingest.isPending) {
      setElapsed(0);
      timer.current = setInterval(() => setElapsed((v) => v + 1), 1000);
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
    };
  }, [ingest.isPending]);

  const submit = async () => {
    if (!parsed.ok) return;
    const response = await ingest.mutateAsync(parsed.value).catch(() => null);
    if (!response) return;
    onClose();
    router.push(`/leads/${response.data.lead.id}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ingest a payload"
      description="POST /api/leads — sent exactly as pasted. Fields may be null, arrays may be empty, and job_information.job_description alone is enough to write a document."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={ingest.isPending}>
            Close
          </Button>
          <Button onClick={submit} loading={ingest.isPending} disabled={!parsed.ok}>
            {ingest.isPending ? `Ingesting ${elapsed ? `(${elapsed}s)` : ""}` : "Ingest"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">start from:</span>
          <Button size="sm" variant="ghost" onClick={() => setText(BLANK)}>
            empty envelope
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setText(DESCRIPTION_ONLY)}>
            description only
          </Button>
          <Field label="">
            <Select
              value={auto}
              onChange={(e) => {
                setAuto(e.target.value);
                setText((current) => {
                  if (!parsed.ok) return current;
                  const clone = JSON.parse(text) as Record<string, unknown>;
                  if (e.target.value) clone.auto = e.target.value;
                  else delete clone.auto;
                  return JSON.stringify(clone, null, 2);
                });
              }}
              className="h-8 w-40 text-xs"
              aria-label="Generation mode"
            >
              <option value="">auto: server default</option>
              <option value="true">auto=true (write the PPD)</option>
              <option value="false">auto=false (store only)</option>
            </Select>
          </Field>
        </div>

        <textarea
          aria-label="Payload JSON"
          rows={18}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className={
            "w-full rounded-lg border bg-canvas p-3 font-mono text-[11px] leading-relaxed focus-ring " +
            (parsed.ok ? "border-line" : "border-danger/60")
          }
        />

        {!parsed.ok ? (
          <p className="text-xs text-danger" role="alert">
            {parsed.message}
          </p>
        ) : (
          <p className="text-[11px] text-muted">
            {String(
              (parsed.value.job_information as Record<string, unknown> | undefined)?.job_description
                ? String(
                    (parsed.value.job_information as Record<string, unknown>).job_description,
                  ).length
                : 0,
            )}{" "}
            characters of post text · everything else optional
          </p>
        )}

        {ingest.isPending ? (
          <p className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-xs text-brand" role="status">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            Storing the payload{elapsed > 8 ? ` — ${elapsed}s` : ""}.
            {String(parsed.ok ? (parsed.value.auto ?? "") : "") !== "false"
              ? " With AUTO_ENRICH_LEADS on, step 1 (the document) runs inside this request and takes 30–60 s; it opens as soon as it is ready."
              : " auto=false, so nothing is generated and this returns immediately."}
          </p>
        ) : null}

        {ingest.error ? (
          <p className="text-xs text-danger" role="alert">
            {errorMessage(ingest.error)}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
