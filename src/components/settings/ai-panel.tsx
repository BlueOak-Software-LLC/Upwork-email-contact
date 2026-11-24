"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api/client";
import type { AiStatus } from "@/lib/api/ai-hooks";

/**
 * /settings/ai — which model writes proposals, and proof that it answers.
 *
 * The panel states the *effective* configuration rather than the env file:
 * `AI_PROVIDER=auto` resolves to Puter or Groq depending on which credential
 * exists, and a revoked token is invisible until something calls it. The probe
 * button is the shortest path to that answer.
 */

interface ProbeResult {
  ok: boolean;
  provider: string;
  model: string;
  ms: number;
  costUsd: number | null;
  costBasis: string;
  reply: string;
  error: string | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}

export function AiPanel({ status }: { status: AiStatus }) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const live = status.provider !== "none";

  async function probe() {
    setProbing(true);
    setFailure(null);
    try {
      const response = await apiFetch<ProbeResult>("/api/ai/test", { method: "POST", body: {} });
      setResult(response.data);
    } catch (error) {
      setResult(null);
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium">Generation provider</h2>
          <Badge tone={live ? (status.provider === "puter" ? "info" : "brand") : "danger"}>
            {status.provider === "none" ? "not configured" : status.provider}
          </Badge>
          {status.requested === "auto" ? (
            <span className="text-xs text-muted">
              AI_PROVIDER=auto, resolved by which credential exists
            </span>
          ) : null}
        </div>

        {status.reason ? (
          <p className="mt-3 rounded-lg border border-danger/35 bg-danger/8 p-3 text-[11px] text-danger">
            {status.reason}. Generation will fail until this is fixed.
          </p>
        ) : null}

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Row
            label="Model"
            value={status.model || "—"}
            hint={
              status.provider === "puter"
                ? "PUTER_MODEL — a Puter model id, e.g. anthropic/claude-sonnet-5-5"
                : "GROQ_MODEL"
            }
          />
          <Row
            label="Fallback model"
            value={status.provider === "puter" ? status.fallbackModel : "— (Groq has none)"}
            hint="Tried once when the first model refuses or is unavailable"
          />
          <Row
            label="Completion budget"
            value={`${status.maxTokens.toLocaleString()} tokens`}
            hint="AI_MAX_TOKENS (defaults to GROQ_MAX_TOKENS)"
          />
          <Row
            label="Call timeout"
            value={`${Math.round(status.timeoutMs / 1000)} s`}
            hint="Must stay under the route's maxDuration of 120 s"
          />
          <Row
            label="Generate on ingest"
            value={status.autoEnrich ? "on (AUTO_ENRICH_LEADS=true)" : "off — click Generate"}
            hint="Off means a payload is stored and nothing is spent until you ask"
          />
          <Row
            label="Groq credential"
            value={status.groqConfigured ? `set (${status.groqModel})` : "not set"}
            hint="Kept as the fallback route"
          />
          <Row
            label="Puter credential"
            value={status.puterConfigured ? "set" : "not set"}
            hint="PUTER_AUTH_TOKEN — billed to that Puter account, no per-minute ceiling"
          />
        </dl>
      </section>

      <section className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-medium">Probe it</h2>
          <Button size="sm" onClick={probe} loading={probing} disabled={!live}>
            Run one 64-token call
          </Button>
          {!live ? <span className="text-xs text-muted">Nothing to call yet.</span> : null}
        </div>

        {result ? (
          <p className="mt-3 text-xs text-muted">
            {result.ok ? (
              <>
                <b className="text-ink">{result.model}</b> answered in {result.ms} ms
                {result.usage
                  ? ` · ${result.usage.prompt_tokens ?? "?"} in / ${result.usage.completion_tokens ?? "?"} out`
                  : ""}
                {result.costUsd !== null
                  ? ` · ${result.costBasis === "billed" ? "charged" : "list price"} $${result.costUsd.toFixed(6)}`
                  : ""}
                {` · reply ${result.reply.slice(0, 60) || "(empty)"}`}
              </>
            ) : (
              <span className="text-danger">{result.error ?? "the probe failed"}</span>
            )}
          </p>
        ) : null}
        {failure ? <p className="mt-3 text-xs text-danger">{failure}</p> : null}

        <p className="mt-3 text-[11px] text-muted/80">
          The probe spends a little of the account&rsquo;s own allowance — a few hundredths of a
          cent on a Sonnet-class model. It tests reachability and credentials, not proposal
          quality; run a real lead for that.
        </p>
      </section>
    </div>
  );
}

function Row({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono text-xs text-ink">{value}</dd>
      <dd className="text-[11px] text-muted/80">{hint}</dd>
    </div>
  );
}
