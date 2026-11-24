"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useRecordOutcome } from "@/lib/api/tracking-hooks";
import type { TrackingOutcomeKind } from "@/types/domain";

const OPTIONS: Array<{ kind: TrackingOutcomeKind; label: string; hint: string }> = [
  { kind: "reply", label: "They replied", hint: "counts toward the reply rate" },
  { kind: "meeting", label: "We met", hint: "also marks the contact replied" },
  { kind: "not_interested", label: "Not interested", hint: "closes the thread" },
];

/**
 * Recording an outcome is a human statement, never a guess: this app does not
 * read a mailbox, so no code here can know that someone answered. It is worth
 * the two clicks because the Overview reply rate is otherwise a number nobody
 * can defend.
 */
export function RecordOutcome({ logId }: { logId: string }) {
  const router = useRouter();
  const record = useRecordOutcome();

  const submit = async (kind: TrackingOutcomeKind) => {
    try {
      await record.mutateAsync({ logId, kind });
      // The timeline and counters on this page are server-rendered.
      router.refresh();
    } catch {
      // `record.isError` renders the reason below; nothing to lose.
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {OPTIONS.map((option) => (
          <Button
            key={option.kind}
            type="button"
            variant="ghost"
            size="sm"
            disabled={record.isPending}
            title={option.hint}
            onClick={() => void submit(option.kind)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      {record.isError ? (
        <p role="alert" className="text-[11px] text-danger">
          {record.error instanceof Error ? record.error.message : "Request failed"}
        </p>
      ) : (
        <p className="text-[11px] text-muted/70">
          Recorded as an event on this message, and folded into the contact&rsquo;s status.
        </p>
      )}
    </div>
  );
}
