import { ModelsPanel } from "@/components/settings/models-panel";
import { aiSettingsView } from "@/server/services/ai/config";

export const dynamic = "force-dynamic";

export const metadata = { title: "AI models · Upwork Outreach" };

/**
 * /settings/models — pick a model and paste a key per provider, in the order
 * the chain should try them: Puter, then Groq, then Gemini.
 *
 * The server renders the effective configuration first, then the client panel
 * writes changes back and re-renders from the recomputed response. That is why
 * a save needs no reload to show "database" as the key source.
 */
export default async function ModelsSettingsPage() {
  const settings = await aiSettingsView();

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-xl font-semibold">AI models</h2>
        <p className="text-sm text-muted">
          Puter answers first, Groq is the fallback, Gemini is the last resort. A provider with no
          API key is skipped entirely — it is never called and never counted as a failure.
        </p>
      </header>

      <ModelsPanel initialData={settings} />
    </div>
  );
}
