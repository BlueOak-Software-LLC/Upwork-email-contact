import Link from "next/link";
import { AiPanel } from "@/components/settings/ai-panel";
import { aiStatus } from "@/server/services/ai";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI status · Upwork Outreach" };

/**
 * /settings/ai — the chain that writes proposals, and proof that it answers.
 *
 * This page is read-only and deliberately does not edit keys: choosing a model
 * and storing a credential belongs on /settings/models, where a save has one
 * obvious effect. Here the operator sees what is live *right now* and can spend
 * one small call to prove it.
 */
export default async function AiSettingsPage() {
  const status = await aiStatus();

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">AI generation</h2>
        <p className="text-sm text-muted">
          Proposals are written on demand: a lead arrives, you click <b>Generate PPD</b>, and the
          first configured model answers.
        </p>
        <Link href="/settings/models" className="inline-block text-sm text-brand underline-offset-4 hover:underline">
          Choose models and API keys →
        </Link>
      </header>

      <AiPanel status={status} />

      <section className="card p-5 text-sm">
        <h3 className="font-medium">Why three providers</h3>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
          <li>
            <b className="text-ink">Puter</b> answers first: the free 550B model is not metered per
            token, so a long PPD adds no token charge. Puter can still refuse when that account&rsquo;s
            allowance is empty, and the chain then moves on. It uses the Puter account behind{" "}
            <code>PUTER_AUTH_TOKEN</code>.
          </li>
          <li>
            <b className="text-ink">Groq</b> is the first fallback: the strongest free-tier model,
            fast and cheap per token, capped at ~8k tokens/minute on the developer tier.
          </li>
          <li>
            <b className="text-ink">Gemini</b> is the last resort: free-tier Flash, reached only when
            the first two are unconfigured or both fail. No key means it is skipped entirely.
          </li>
          <li>
            The prompt, the PPD contract, sanitising and the review flow are identical for every
            provider, so switching is a config change — never a code change.
          </li>
        </ul>
      </section>
    </div>
  );
}
