"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { errorMessage } from "@/lib/api/errors";
import { useIngestLead } from "@/lib/api/outreach-hooks";
import { useRouter } from "next/navigation";

/**
 * Paste a scraper payload straight into POST /api/leads.
 *
 * The body is sent **exactly as pasted** — it is what lands in
 * `leads.raw_payload` — so generation mode rides on the query string
 * (`?auto=true|false&regenerate=true`), never inside the JSON.
 *
 * Nothing is pre-filled with invented facts: the two starters are the shapes the
 * API accepts, including the description-only case where every identifier is
 * null.
 */

const BLANK = `{
  "job_id": "",
  "job_title": "",
  "job_url": "",
  "job_information": {
    "job_title": "",
    "job_description": ""
  },
  "contact_information": {
    "verified_contacts": [],
    "potential_contacts": []
  }
}`;

const DESCRIPTION_ONLY = `{
  "job_id": null,
  "job_title": null,
  "job_url": null,
  "job_information": {
    "job_title": null,
    "job_description": "We need a photoreal 3D animation of our autonomous mobile robot picking cases off a pallet in a warehouse aisle. 12 short clips, 1080p and 4K, delivered inside three weeks. Rig files are available; the robot's paint scheme must match our brand."
  },
  "contact_information": {
    "verified_contacts": [],
    "potential_contacts": []
  }
}`;

export function IngestDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState("");
  // Manual is the default now: a paste should store, not spend tokens.
  const [auto, setAuto] = useState<"" | "true" | "false">("false");
  const [regenerate, setRegenerate] = useState(false);
  const [refresh, setRefresh] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const router = useRouter();
  const ingest = useIngestLead();

  const parsed = useMemo(() => {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false as const, message: "Paste the research JSON first." };
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false as const, message: "The top level must be a JSON object." };
      }
      const ji = (value.job_information ?? {}) as Record<string, unknown>;
      const description = String(ji.job_description ?? value.job_description ?? "");
      return { ok: true as const, value, description: description.length };
    } catch (error) {
      return {
        ok: false as const,
        message: `Not valid JSON: ${(error as Error).message}`,
      };
    }
  }, [text]);

  const query = [
    auto ? `auto=${auto}` : "",
    regenerate ? "regenerate=true" : "",
    refresh ? "refresh=true" : "",
  ]
    .filter(Boolean)
    .join("&");

  useEffect(() => {
    if (!ingest.isPending) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = window.setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(id);
  }, [ingest.isPending]);

  useEffect(() => {
    if (!open) ingest.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    if (!parsed.ok) return;
    const response = await ingest.mutateAsync({
      payload: parsed.value,
      query,
    });
    if (!response) return;
    onClose();
    router.push(`/leads/${response.data.lead.id}`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ingest a payload"
      description="POST /api/leads — the body is stored exactly as pasted. Fields may be null and arrays may be empty: job_information.job_description alone is enough to write a document."
      className="max-w-2xl"
      footer={
        <>
          <span className="mr-auto font-mono text-[10px] text-faint">
            POST /api/leads{query ? `?${query}` : ""}
          </span>
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
        <div className="flex flex-wrap items-end gap-2">
          <span className="text-xs text-muted">start from:</span>
          <Button size="sm" variant="ghost" onClick={() => setText(BLANK)}>
            empty envelope
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setText(DESCRIPTION_ONLY)}>
            description only
          </Button>
          <Field label="generation">
            <Select
              value={auto}
              onChange={(event) => setAuto(event.target.value as "" | "true" | "false")}
              className="h-8 w-48 text-xs"
              aria-label="Generation mode"
            >
              <option value="">store only (manual Generate PPD)</option>
              <option value="false">?auto=false — store only, I will click Generate</option>
              <option value="true">?auto=true — write the PPD inside this request</option>
            </Select>
          </Field>
          <label className="flex items-center gap-2 pb-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={regenerate}
              onChange={(event) => setRegenerate(event.target.checked)}
              className="accent-brand"
              aria-label="Regenerate"
            />
            <code className="font-mono text-[11px]">?regenerate=true</code>
          </label>
          <label className="flex items-center gap-2 pb-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={refresh}
              onChange={(event) => setRefresh(event.target.checked)}
              className="accent-brand"
              aria-label="Refresh duplicate"
            />
            <code className="font-mono text-[11px]">?refresh=true</code>
            <span className="text-muted/80">overwrite a matched job_id / link</span>
          </label>
        </div>

        <Textarea
          aria-label="Payload JSON"
          rows={17}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="font-mono text-[11px] leading-relaxed"
        />

        {!parsed.ok ? (
          <p className="text-xs text-danger" role="alert">
            {parsed.message}
          </p>
        ) : (
          <p className="text-[11px] text-muted">
            <span className="font-mono">{parsed.description}</span> characters of post text ·
            duplicate posts merge onto the existing lead by its dedupe key
          </p>
        )}

        {ingest.isPending ? (
          <p
            className="flex items-center gap-2 rounded-lg border border-brand/40 bg-brand/10 px-3 py-2 text-xs text-brand"
            role="status"
          >
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            Storing the payload{elapsed > 8 ? ` — ${elapsed}s` : ""}.
            {auto !== "true"
              ? " Nothing is generated, so this returns immediately."
              : " With generation on, step 1 (the document) runs inside this request and takes 30–60 s; the lead page opens as soon as it is ready."}
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
