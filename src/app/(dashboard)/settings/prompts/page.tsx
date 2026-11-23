import { PromptEditor } from "@/components/prompts/prompt-editor";

export const dynamic = "force-dynamic";

export const metadata = { title: "Prompts · Upwork Outreach" };

/**
 * /settings/prompts — the two Groq prompt pairs used by the pipeline.
 *
 * `ppd_document` runs at step 1 (the proposal document only), `email_draft`
 * runs at step 3 against the reviewed PPD. Saved edits live in the
 * `prompt_templates` table; resetting removes the row so the code default in
 * `src/server/services/prompts/proposal.prompt.ts` applies again.
 */
export default async function PromptsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">Prompts</h2>
        <p className="text-sm text-muted">
          Two prompts, two steps. The document prompt writes the PPD; the email
          prompt writes the outreach copy from the PPD you reviewed. The PDF is
          never model-written — it compiles from the reviewed document.
        </p>
      </header>

      <div className="space-y-4">
        <PromptEditor promptKey="ppd_document" defaultOpen />
        <PromptEditor promptKey="email_draft" />
      </div>

      <section className="card p-5 text-sm">
        <h3 className="font-medium">How the knobs behave</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>
            <b className="text-ink">max_tokens</b> is the whole completion budget, including
            GPT-OSS reasoning tokens. The PPD pass wants at least 9,000; the email pass is
            comfortable around 4,000.
          </li>
          <li>
            <b className="text-ink">reasoning_effort</b> low ≈ 6 s / ~500 words / $0.0013;
            medium ≈ 16 s / ~880 words / $0.002; leaving it at the model default ≈ 19 s and
            most of the budget spent on reasoning.
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
