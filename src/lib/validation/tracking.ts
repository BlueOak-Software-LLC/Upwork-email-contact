import { z } from "zod";

/**
 * Engagement is recorded by a human, not inferred. This app never reads a
 * mailbox, so "they replied" is a statement about the world that only the
 * sender can make — and it is worth writing down, because reply rate is the
 * number the outreach is actually judged on.
 */
export const recordOutcomeSchema = z.object({
  logId: z.string().uuid(),
  kind: z.enum(["reply", "meeting", "not_interested"]),
});

export type RecordOutcomeInput = z.infer<typeof recordOutcomeSchema>;
