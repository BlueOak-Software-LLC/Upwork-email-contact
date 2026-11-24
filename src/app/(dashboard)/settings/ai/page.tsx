import { AiPanel } from "@/components/settings/ai-panel";
import { aiStatus } from "@/server/services/ai";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI · Upwork Outreach" };

/**
 * /settings/ai — the model that writes proposals and the credential behind it.
 *
 * Two providers reach the same prompt: Puter (no key of ours, billed to the
 * Puter account, no per-minute token ceiling) and Groq (fast, cheap per token,
 * capped by the tier). This page says which one is live right now, because
 * `AI_PROVIDER=auto` resolves at runtime from whichever credential exists.
 */
export default function AiSettingsPage() {
  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">AI generation</h2>
        <p className="text-sm text-muted">
          Proposals are written on demand: a lead arrives, you click <b>Generate PPD</b>, and the
          model below answers. Nothing generates itself on ingest.
        </p>
      </header>

      <AiPanel status={aiStatus()} />

      <section className="card p-5 text-sm">
        <h3 className="font-medium">Why two providers</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>
            <b className="text-ink">Puter</b> is the default: it holds no API key of ours, bills the
            Puter account behind <code>PUTER_AUTH_TOKEN</code>, and has no tokens-per-minute wall —
            the limit that blocked generation on Groq&rsquo;s free tier.
          </li>
          <li>
            <b className="text-ink">Groq</b> stays configured as the fallback: much faster per token
            and cheaper per document, but the developer tier allows ~8k tokens/minute and ~200k a
            day, which is around 35 documents.
          </li>
          <li>
            The prompt, the PPD contract, sanitising and the review flow are identical for both, so
            switching is a config change — never a code change.
          </li>
        </ul>
      </section>
    </div>
  );
}
