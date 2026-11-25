import { PromptEditor } from "@/components/prompts/prompt-editor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Prompts · Upwork Outreach" };

/**
 * /settings/prompts — the three prompt pairs used by the pipeline. They are
 * pasted into the signed-in ChatGPT tab, so the model there answers them.
 *
 * `ppd_document` runs at step 1 (the proposal document only), `email_draft`
 * runs at step 3 against the reviewed PPD, and `follow_up` runs for a second
 * (or later) message on a thread that was already sent. Saved edits live in the
 * `prompt_templates` table; resetting removes the row so the code default in
 * `src/server/services/prompts/proposal.prompt.ts` applies again.
 */
export default async function PromptsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Prompts</h2>
        <p className="text-sm text-muted">
          Three prompts: the document, the first outreach email, and each
          follow-up. These templates are workspace-wide: every signed-in user
          runs the same text in their own ChatGPT tab, so one person changing a
          prompt changes it for the whole team. The PDF is never model-written —
          it compiles from the reviewed document.
        </p>
      </header>

      <div className="space-y-4">
        <PromptEditor promptKey="ppd_document" defaultOpen />
        <PromptEditor promptKey="email_draft" />
        <PromptEditor promptKey="follow_up" />
      </div>

      <section className="card p-5 text-sm">
        <h3 className="font-medium">How generation behaves</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>
            <b className="text-ink">No model API key is used.</b> The prompt is sent to the
            ChatGPT tab where you are signed in; the model, thinking time and any usage limit
            belong to that ChatGPT account, not to this server. Temperature and token knobs are
            kept with the template for reference but the browser session decides them.
          </li>
         <li>
            <b className="text-ink">Your identity is not a prompt slot.</b> Company, site, byline
            and the email sign-off come from <code className="rounded bg-canvas px-1">PROPOSAL_*</code>{" "}
            and <code className="rounded bg-canvas px-1">EMAIL_FROM</code>, and the server stamps them
            after the model answers — an edited prompt can never change who signs, and any bracketed
            placeholder the model still writes is rewritten into prose instead of reaching a client.
          </li>
          <li>
            Slots that have no value (a typo) stay literally in the prompt and are reported by{" "}
            <code className="rounded bg-canvas px-1">GET /api/prompts</code> rather than silently
            deleted.
          </li>
        </ul>
      </section>
    </div>
  );
}
