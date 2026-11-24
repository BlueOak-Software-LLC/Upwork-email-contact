"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  useAiSettings,
  useResetAiSettings,
  useSaveAiSettings,
  type AiProviderSettings,
  type AiSettings,
} from "@/lib/api/ai-hooks";
import { AI_PROVIDER_META } from "@/lib/ai-models";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { Field, Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";

/**
 * /settings/models — the operator-facing half of the provider config.
 *
 * The rule on this page is that a saved value is *visible as saved*: every
 * response is the recomputed effective configuration, so the badge flips from
 * "environment" to "database" the moment Postgres accepts the write. Keys are
 * write-only — the API never returns one, and the input is cleared on success.
 *
 * Nothing here is required to run the app. An empty database plus a populated
 * .env.local is a working deployment; this page is how you stop editing the
 * env file to change a model or rotate a key.
 */
export function ModelsPanel({ initialData }: { initialData: AiSettings }) {
  const settings = useAiSettings(initialData);
  const data = settings.data ?? initialData;

  return (
    <div className="space-y-5">
      <ChainSummary settings={data} />

      {!data.storageReady ? (
        <p className="rounded-lg border border-danger/35 bg-danger/8 p-3 text-xs text-danger">
          <b>Migration 0006 is not applied</b>, so provider keys and model overrides cannot be
          saved yet. Environment variables still generate normally. Apply{" "}
          <code>supabase/migrations/0006_ai_settings.sql</code> in the Supabase SQL editor, then
          reload this page.
        </p>
      ) : null}

      {!data.encryptionReady ? (
        <p className="rounded-lg border border-warn/35 bg-warn/8 p-3 text-xs text-warn">
          <b>APP_ENCRYPTION_KEY is not set</b>, so keys cannot be stored in Postgres. The
          environment variables still work. Set a 32-byte key and restart to enable saving.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        {data.providers.map((provider) => (
          <ProviderCard key={provider.provider} item={provider} />
        ))}
      </div>

      <section className="card p-5 text-xs text-muted/80">
        <h3 className="text-sm font-medium text-ink">How precedence works</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            A value saved on this page wins: it survives restarts and redeploys without touching
            the environment.
          </li>
          <li>
            Otherwise the environment variable is used — the bootstrap path for a fresh deployment.
          </li>
          <li>
            Otherwise the built-in free model id in <code>src/lib/ai-models.ts</code> applies.
          </li>
        </ol>
        <p className="mt-3">
          A provider with no credential is <b>skipped</b>, not counted as a failure.{" "}
          <code>AI_PROVIDER=none</code> disables generation entirely;{" "}
          <code>AI_FALLBACK_PROVIDER=none</code> keeps only the first configured provider. Model ids
          are provider-specific: a Puter id on the Groq card will fail at call time, so use the
          suggestions.
        </p>
        <p className="mt-3">
          Read-only status and a live test call live on{" "}
          <Link href="/settings/ai" className="text-brand underline-offset-4 hover:underline">
            /settings/ai
          </Link>
          .
        </p>
      </section>
    </div>
  );
}

function ChainSummary({ settings }: { settings: AiSettings }) {
  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium">Fallback order</h2>
        <Badge tone="neutral">{settings.providerOrder}</Badge>
        <Badge tone="neutral">{settings.activeOrder.length} active</Badge>
        {settings.requested !== "auto" ? (
          <Badge tone="warn">AI_PROVIDER={settings.requested}</Badge>
        ) : null}
      </div>

      {settings.chain.length === 0 ? (
        <p className="mt-3 rounded-lg border border-danger/35 bg-danger/8 p-3 text-xs text-danger">
          {settings.reason ?? "No provider has a credential yet."}
        </p>
      ) : (
        <ol className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          {settings.chain.map((leg, index) => (
            <li key={leg.provider} className="flex items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-1.5">
                <span className="font-mono text-[10px] text-faint">{index + 1}</span>
                <b className="text-ink">{AI_PROVIDER_META[leg.provider].label}</b>
                <code className="text-[11px] text-muted">{leg.model}</code>
              </span>
              {index < settings.chain.length - 1 ? <span className="text-faint">→</span> : null}
            </li>
          ))}
        </ol>
      )}

      {settings.reason ? (
        <p className="mt-3 text-xs text-warn">{settings.reason}</p>
      ) : (
        <p className="mt-3 text-xs text-muted">
          The first provider answers; the next one is tried only if it fails. A provider without a
          key is not in the list at all.
        </p>
      )}
    </section>
  );
}

function ProviderCard({ item }: { item: AiProviderSettings }) {
  const meta = AI_PROVIDER_META[item.provider];
  const save = useSaveAiSettings();
  const reset = useResetAiSettings();
  const toast = useToast();

  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(item.model);
  const [fallbackModel, setFallbackModel] = useState(item.fallbackModel ?? "");
  const [enabled, setEnabled] = useState(item.enabled);

  // The server response is the source of truth. Syncing the drafts here means a
  // reset or a save elsewhere (another tab) is reflected without a reload.
  useEffect(() => {
    setModel(item.model);
    setFallbackModel(item.fallbackModel ?? "");
    setEnabled(item.enabled);
  }, [item.model, item.fallbackModel, item.enabled]);

  const busy = save.isPending || reset.isPending;

  async function saveKey() {
    if (!apiKey.trim()) return;
    try {
      await save.mutateAsync({ provider: item.provider, apiKey: apiKey.trim() });
      setApiKey("");
      toast.success(`${meta.label} key saved`, "It is encrypted in Postgres and used immediately.");
    } catch (error) {
      toast.error("Could not save the key", error instanceof Error ? error.message : String(error));
    }
  }

  async function saveModel() {
    try {
      await save.mutateAsync({
        provider: item.provider,
        model: model.trim(),
        fallbackModel: meta.defaultFallbackModel !== null ? fallbackModel.trim() || null : undefined,
        enabled,
      });
      toast.success(`${meta.label} settings saved`);
    } catch (error) {
      toast.error("Could not save the model", error instanceof Error ? error.message : String(error));
    }
  }

  async function removeKey() {
    try {
      await save.mutateAsync({ provider: item.provider, clearKey: true });
      toast.info(`${meta.label} saved key removed`, "The environment variable (if any) takes over.");
    } catch (error) {
      toast.error("Could not remove the key", error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <section className="card flex flex-col gap-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{meta.label}</h3>
        {item.configured ? (
          <Badge tone={item.keySource === "database" ? "brand" : "info"}>
            key · {item.keySource}
          </Badge>
        ) : (
          <Badge tone="danger">no key — skipped</Badge>
        )}
        {item.enabled ? null : <Badge tone="warn">disabled</Badge>}
        {item.inChain ? <Badge tone="neutral">in chain</Badge> : null}
      </div>

      <p className="text-[11px] text-muted/80">
        {item.keySource === "database"
          ? "A key is stored (encrypted). Leave the field blank to keep it."
          : item.keySource === "environment"
            ? `Using ${meta.envVar} from the environment. Saving a key here overrides it.`
            : `No credential. Paste a ${meta.credentialLabel} to put ${meta.label} in the chain.`}{" "}
        <a
          href={meta.credentialUrl}
          target="_blank"
          rel="noreferrer"
          className="text-brand underline-offset-4 hover:underline"
        >
          Get one ↗
        </a>
      </p>

      <div className="space-y-2">
        <Field label={meta.credentialLabel} hint="Write-only: the API never returns it.">
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              item.keySource === "database" ? "Stored — paste a new key to replace it" : "Paste the key"
            }
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={saveKey} loading={save.isPending} disabled={!apiKey.trim() || busy}>
            Save key
          </Button>
          {item.keySource === "database" ? (
            <Button size="sm" variant="ghost" onClick={removeKey} disabled={busy}>
              Remove saved key
            </Button>
          ) : null}
        </div>
      </div>

      <div className="space-y-2">
        <Field
          label="Model"
          hint={
            item.modelSource === "database"
              ? "Saved. Clear the field to return to the env/default model."
              : item.modelSource === "environment"
                ? "From the environment. A saved value overrides it."
                : `Free default: ${meta.defaultModel}`
          }
        >
          <Input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            list={`models-${item.provider}`}
            placeholder={meta.defaultModel}
            spellCheck={false}
          />
          <datalist id={`models-${item.provider}`}>
            {meta.presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.note}
              </option>
            ))}
          </datalist>
        </Field>

        {meta.defaultFallbackModel !== null ? (
          <Field
            label="Fallback model"
            hint="Tried once inside this provider when the first model refuses."
          >
            <Input
              value={fallbackModel}
              onChange={(event) => setFallbackModel(event.target.value)}
              list={`fallback-models-${item.provider}`}
              placeholder={meta.defaultFallbackModel}
              spellCheck={false}
            />
            <datalist id={`fallback-models-${item.provider}`}>
              {meta.presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label} — {preset.note}
                </option>
              ))}
            </datalist>
          </Field>
        ) : null}

        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-3.5 w-3.5 accent-[var(--brand)]"
          />
          Include this provider in the fallback chain
        </label>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" onClick={saveModel} loading={save.isPending} disabled={busy}>
            Save model
          </Button>
          <ConfirmAction
            label="Reset provider"
            confirmLabel="Reset"
            title={`Reset ${meta.label}?`}
            description={`Deletes the saved key, model and enabled flag for ${meta.label}, so ${meta.envVar} and the built-in default apply again.`}
            busy={reset.isPending}
            onConfirm={async () => {
              try {
                await reset.mutateAsync(item.provider);
                toast.success(`${meta.label} reset to environment/default`);
              } catch (error) {
                toast.error(
                  "Could not reset the provider",
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          />
        </div>
      </div>
    </section>
  );
}
