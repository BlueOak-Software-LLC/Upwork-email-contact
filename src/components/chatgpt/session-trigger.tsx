"use client";

import { useChatGptSession } from "./session-provider";

export function ChatGptSessionTrigger() {
  const { setOpen, jobs, connection, busyJobId } = useChatGptSession();
  const running = jobs.some(
    (job) => job.status === "queued" || job.status === "running" || job.status === "completing",
  );
  const count = busyJobId ? 1 : running ? 1 : 0;

  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="inline-flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-xs font-medium text-muted transition hover:border-brand/50 hover:text-ink focus-ring"
      aria-label="Open the ChatGPT session drawer"
    >
      <span
        aria-hidden
        className={
          "h-1.5 w-1.5 rounded-full " +
          (connection === "connected"
            ? "bg-brand"
            : connection === "connecting"
              ? "bg-info"
              : "bg-warn")
        }
      />
      <span className="hidden sm:inline">ChatGPT</span>
      {count ? (
        <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold text-brand-ink">
          {count}
        </span>
      ) : null}
    </button>
  );
}
