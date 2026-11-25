"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useChatGptSession, type SessionJob } from "./session-provider";

const KIND_LABEL: Record<SessionJob["kind"], string> = {
  ppd_document: "PPD document",
  email_draft: "First email",
  follow_up: "Follow-up",
};

const PHASE_LABEL: Record<NonNullable<SessionJob["phase"]>, string> = {
  opening: "opening ChatGPT",
  typing: "typing the prompt",
  waiting: "waiting for the answer",
  copying: "copying the answer",
  done: "finishing",
};

const STATUS_TONE = {
  queued: "neutral",
  running: "info",
  completing: "info",
  completed: "brand",
  failed: "danger",
  cancelled: "neutral",
} as const;

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fullPrompt(job: SessionJob) {
  return job.system ? `${job.system}\n\n---\n\n${job.prompt}` : job.prompt;
}

export function ChatGptSessionDrawer() {
  const {
    open,
    setOpen,
    jobs,
    connection,
    extensionVersion,
    chatTabOpen,
    busyJobId,
    retryConnection,
    focusChat,
  } = useChatGptSession();

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  const active = jobs.filter((job) =>
    job.status === "queued" || job.status === "running" || job.status === "completing",
  );

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label="ChatGPT session">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={() => setOpen(false)} aria-hidden />
      <aside className="animate-pop-in absolute inset-y-0 right-0 flex w-full max-w-[580px] flex-col border-l border-line bg-surface shadow-[var(--shadow-float)]">
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">ChatGPT session</h2>
              <Badge tone={connection === "connected" ? "brand" : connection === "connecting" ? "info" : "warn"}>
                {connection === "connected" ? "connected" : connection === "connecting" ? "connecting" : "extension missing"}
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-muted">
              Prompts run in the ChatGPT tab where you are already signed in. No API key is used.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close ChatGPT session"
            className="rounded-md p-1 text-muted transition hover:bg-surface-2 hover:text-ink focus-ring"
          >
            ✕
          </button>
        </header>

        <div className="border-b border-line-soft px-4 py-2 text-[11px] text-muted">
          {connection === "connected" ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>Extension {extensionVersion ?? "unknown"}</span>
              <span>{chatTabOpen ? "ChatGPT tab open" : "ChatGPT tab will open on the first run"}</span>
              <button type="button" onClick={focusChat} className="text-brand hover:underline focus-ring">
                Show ChatGPT tab
              </button>
            </div>
          ) : connection === "connecting" ? (
            <span>Looking for the companion extension…</span>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span>
                Load the <code className="rounded bg-canvas px-1">chatgpt-extension</code> folder in
                chrome://extensions (Developer mode → Load unpacked), then reconnect.
              </span>
              <Button size="sm" variant="secondary" onClick={retryConnection}>
                Reconnect
              </Button>
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {jobs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-line p-5 text-sm text-muted">
              <p className="font-medium text-ink">No ChatGPT jobs for this lead yet.</p>
              <p className="mt-1 text-xs">
                Click <b>Generate PPD</b> or <b>Generate email draft</b>. The prompt appears here,
                the extension types it into ChatGPT, and the answer comes back into this drawer.
              </p>
            </div>
          ) : (
            jobs.map((job) => <JobCard key={job.id} job={job} busy={busyJobId === job.id} />)
          )}
        </div>

        <footer className="border-t border-line px-4 py-2 text-[11px] text-faint">
          {active.length ? `${active.length} run${active.length === 1 ? "" : "s"} in progress` : "Idle"}
          {" · "}
          the answer is parsed and saved on the server, never written straight from the browser.
        </footer>
      </aside>
    </div>
  );
}

function JobCard({ job, busy }: { job: SessionJob; busy: boolean }) {
  const { run, cancel, submitPastedAnswer, dismiss, connection } = useChatGptSession();
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState("");
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);

  const active = job.status === "queued" || job.status === "running" || job.status === "completing";
  // `completing` means a server request is already parsing/writing the answer.
  // Cancelling or pasting then would race that write, so only browser work is
  // cancellable/editable here.
  const canCancel = job.status === "queued" || job.status === "running";
  // A failed job can still be saved by pasting the answer the person already
  // has in the ChatGPT tab; submitting reopens it server-side.
  const canPaste = job.status === "running" || job.status === "failed";
  const answer = job.responseText ?? "";
  const logs = job.logs ?? [];
  const latestLog = logs[logs.length - 1];

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  }

  async function onRun() {
    setPending(true);
    await run(job);
    setPending(false);
  }

  async function onPaste() {
    if (!manual.trim()) return;
    setPending(true);
    await submitPastedAnswer(job.id, manual);
    setPending(false);
  }

  return (
    <article className="rounded-xl border border-line bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={STATUS_TONE[job.status]}>{job.status}</Badge>
          <span className="truncate text-sm font-medium">{KIND_LABEL[job.kind]}</span>
          <span className="text-[11px] text-faint">{time(job.createdAt)}</span>
        </div>
        <div className="flex items-center gap-1">
          {active && job.status === "queued" && connection === "connected" ? (
            <Button size="sm" variant="secondary" onClick={onRun} loading={pending}>
              Run
            </Button>
          ) : null}
          {canCancel ? (
            <Button size="sm" variant="ghost" onClick={() => void cancel(job.id)}>
              Cancel
            </Button>
          ) : !active ? (
            <Button size="sm" variant="ghost" onClick={() => dismiss(job.id)}>
              Dismiss
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide" : "Details"}
          </Button>
        </div>
      </div>

      {job.status === "completing" ? (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-info">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" aria-hidden />
          saving the answer on the server
        </p>
      ) : job.status === "running" && job.phase ? (
        <p className="mt-2 flex items-center gap-2 text-[11px] text-info">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-info" aria-hidden />
          {PHASE_LABEL[job.phase]}{job.liveText ? ` · ${job.liveText}` : ""}
        </p>
      ) : null}

      {latestLog ? (
        <p className="mt-1 truncate text-[10px] text-faint" title={latestLog.message}>
          <span className="tabular-nums">{clock(latestLog.at)}</span> · {latestLog.message}
        </p>
      ) : null}

      {job.status === "failed" && job.error ? (
        <p className="mt-2 rounded-lg border border-danger/30 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">
          {job.error}
        </p>
      ) : null}

      {job.status === "completed" && answer ? (
        <div className="mt-2 space-y-2">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-canvas p-2 text-[11px] leading-relaxed text-ink">
            {answer.length > 2_400 ? `${answer.slice(0, 2_400)}…` : answer}
          </pre>
          <button
            type="button"
            onClick={() => void copy(answer)}
            className="text-[11px] text-brand hover:underline focus-ring"
          >
            {copied ? "Copied" : "Copy full answer"}
          </button>
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-line-soft pt-3">
          {logs.length ? (
            <div>
              <p className="mb-1 text-[11px] font-medium text-muted">Extension log</p>
              <ol className="max-h-52 space-y-1 overflow-y-auto rounded-lg bg-canvas p-2 text-[10px] leading-relaxed text-muted">
                {logs.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="flex gap-2">
                    <span className="shrink-0 tabular-nums text-faint">{clock(entry.at)}</span>
                    <span className="min-w-0 break-words">{entry.message}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          <div>
            <p className="mb-1 text-[11px] font-medium text-muted">Prompt sent to ChatGPT</p>
            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-canvas p-2 text-[10px] leading-relaxed text-muted">
              {fullPrompt(job)}
            </pre>
            <button
              type="button"
              onClick={() => void copy(fullPrompt(job))}
              className="mt-1 text-[11px] text-brand hover:underline focus-ring"
            >
              Copy prompt
            </button>
          </div>
          {job.promptMeta.unknownVars.length ? (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5 text-[10px] text-warn">
              Unfilled prompt slots: {job.promptMeta.unknownVars.join(", ")}
            </p>
          ) : null}
          {canPaste ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted" htmlFor={`manual-${job.id}`}>
                {job.status === "failed"
                  ? "The tab stopped early. Paste its answer here to save it without rerunning."
                  : "If the answer needs correcting, paste the complete response here."}
              </label>
              <textarea
                id={`manual-${job.id}`}
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                rows={5}
                placeholder="Paste the ChatGPT response, then press Save answer."
                className="w-full rounded-lg border border-line bg-canvas px-2 py-1.5 text-xs focus-ring"
              />
              <Button
                size="sm"
                className="mt-2"
                onClick={() => void onPaste()}
                disabled={!manual.trim()}
                loading={pending}
              >
                Save answer
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {busy ? <span className="sr-only">This job is running</span> : null}
    </article>
  );
}

