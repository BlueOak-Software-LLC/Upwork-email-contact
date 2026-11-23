"use client";

import { useEffect, useRef, useState } from "react";
import { usePrompts, useResetPrompt, useSavePrompt, type PromptDto } from "@/lib/api/outreach-hooks";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Edit one Groq prompt pair (system + `{{variable}}` user template) and its
 * model knobs. Used inline on the lead page and on /settings/prompts.
 *
 * Slots that have no value (a typo like `{{job_descritpion}}`) are highlighted
 * from `used`/`variables` returned by GET /api/prompts, and stay literally in
 * the rendered prompt instead of vanishing.
 */
export function PromptEditor({
  promptKey,
  defaultOpen = false,
}: {
  promptKey: PromptDto["key"];
  defaultOpen?: boolean;
}) {
  const library = usePrompts();
  const save = useSavePrompt();
  const reset = useResetPrompt();

  const definition = library.data?.prompts.find((p) => p.key === promptKey);
  const [open, setOpen] = useState(defaultOpen);
  const [system, setSystem] = useState("");
  const [user, setUser] = useState("");
  const [temperature, setTemperature] = useState("0.45");
  const [maxTokens, setMaxTokens] = useState("");
  const [effort, setEffort] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!definition || dirty) return;
    setSystem(definition.system);
    setUser(definition.user);
    setTemperature(String(definition.temperature));
    setMaxTokens(definition.maxTokens ? String(definition.maxTokens) : "");
    setEffort(definition.reasoningEffort ?? "");
  }, [definition, dirty]);

  const known = new Set((library.data?.variables ?? []).map((v) => v.name));
  const usedNames = (library.data?.used ?? [])
    .filter((u) => u.key === promptKey)
    .flatMap((u) => [...u.system, ...u.user]);
  const unknown = usedNames.filter((name) => !known.has(name));
  const unused = [...known].filter((name) => !usedNames.includes(name));

  // Clicking a variable drops {{name}} where the caret is.
  const systemRef = useRef<HTMLTextAreaElement | null>(null);
  const userRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFocused = useRef<"system" | "user">("user");

  const insertVariable = (name: string) => {
    const target = lastFocused.current === "system" ? systemRef : userRef;
    const el = target.current;
    const token = `{{${name}}}`;
    if (!el) {
      setUser((v) => v + token);
      setDirty(true);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    if (lastFocused.current === "system") setSystem(next);
    else setUser(next);
    setDirty(true);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const recommended = promptKey === "ppd_document" ? 6_000 : 2_000;
  const budgetLow = maxTokens.trim() !== "" && Number(maxTokens) < recommended;

  const pending = save.isPending || reset.isPending;

  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-2">
          <span className="text-sm font-medium">
            {definition ? definition.label : promptKey} prompt
          </span>
          {definition ? (
            <Badge tone={definition.isDefault ? "neutral" : "brand"}>
              {definition.isDefault ? "code default" : "customized"}
            </Badge>
          ) : null}
          {dirty ? <Badge tone="warn">unsaved</Badge> : null}
          {unknown.length ? <Badge tone="warn">{unknown.length} unknown slot(s)</Badge> : null}
        </span>
        <span className="text-xs text-muted">{open ? "hide" : "show & edit"}</span>
      </button>

      {open ? (
        <div className="space-y-4 border-t border-line p-4">
          {definition?.note ? (
            <p className="text-xs text-muted">{definition.note}</p>
          ) : null}

          <Field
            label="System prompt"
            hint="Role, factual rules and the output contract. Use {{variables}} anywhere."
          >
            <Textarea
              ref={systemRef}
              rows={10}
              value={system}
              onFocus={() => {
                lastFocused.current = "system";
              }}
              onChange={(e) => {
                setSystem(e.target.value);
                setDirty(true);
              }}
              className="font-mono text-[11px] leading-relaxed"
            />
          </Field>

          <Field label="User prompt template" hint="The per-lead brief. Every {{slot}} is filled at generation time.">
            <Textarea
              ref={userRef}
              rows={16}
              value={user}
              onFocus={() => {
                lastFocused.current = "user";
              }}
              onChange={(e) => {
                setUser(e.target.value);
                setDirty(true);
              }}
              className="font-mono text-[11px] leading-relaxed"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Temperature">
              <Input
                type="number"
                step="0.05"
                min="0"
                max="2"
                value={temperature}
                onChange={(e) => {
                  setTemperature(e.target.value);
                  setDirty(true);
                }}
              />
            </Field>
            <Field
              label="max_tokens"
              hint={
                budgetLow
                  ? `empty = GROQ_MAX_TOKENS · this is the whole completion budget, reasoning included`
                  : "empty = GROQ_MAX_TOKENS"
              }
            >
              <Input
                type="number"
                value={maxTokens}
                placeholder="12000"
                aria-invalid={budgetLow || undefined}
                onChange={(e) => {
                  setMaxTokens(e.target.value);
                  setDirty(true);
                }}
                className={budgetLow ? "border-warn/70" : undefined}
              />
            </Field>
            <Field label="reasoning_effort" hint="empty = GROQ_REASONING_EFFORT">
              <Select
                value={effort}
                onChange={(e) => {
                  setEffort(e.target.value);
                  setDirty(true);
                }}
              >
                <option value="">(env default, auto-tuned)</option>
                <option value="none">none — whole budget to the document</option>
                <option value="minimal">minimal</option>
                <option value="low">low — fast, cheap, terser</option>
                <option value="medium">medium — balanced</option>
                <option value="high">high — slowest, longest</option>
              </Select>
            </Field>
          </div>

          {budgetLow ? (
            <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              {maxTokens} completion tokens is under the ~{recommended.toLocaleString()} this step
              needs. {promptKey === "ppd_document"
                ? "A 700–1,000 word document costs roughly 4,000–6,000 tokens plus its reasoning, so a tight budget truncates the section list."
                : "Short subjects and 90-word bodies cost roughly 1,200–1,800 tokens plus reasoning."}{" "}
              The API will still warn when output is truncated.
            </p>
          ) : null}

          <details className="rounded-lg bg-canvas p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted">
              Available variables ({known.size}) — click to insert at the caret
            </summary>
            <ul className="mt-2 grid gap-x-6 gap-y-1 text-[11px] sm:grid-cols-2">
              {(library.data?.variables ?? []).map((variable) => (
                <li key={variable.name} className="flex items-start gap-2">
                  <button
                    type="button"
                    onClick={() => insertVariable(variable.name)}
                    title={`Insert {{${variable.name}}}`}
                    className={cn(
                      "shrink-0 rounded border px-1 font-mono transition hover:border-brand/60 hover:text-ink focus-ring",
                      usedNames.includes(variable.name)
                        ? "border-brand/40 bg-brand/10 text-brand"
                        : "border-line bg-surface-2 text-muted",
                    )}
                  >
                    {`{{${variable.name}}}`}
                  </button>
                  <span className="text-muted">{variable.description}</span>
                </li>
              ))}
            </ul>
            {unknown.length ? (
              <p className="mt-2 text-[11px] text-warn">
                Not substituted (left as typed): {unknown.map((u) => `{{${u}}}`).join(", ")}
              </p>
            ) : null}
            {unused.length > 0 && unused.length < known.size ? (
              <p className="mt-2 text-[11px] text-muted">
                Available but unused here: {unused.slice(0, 12).map((u) => `{{${u}}}`).join(", ")}
                {unused.length > 12 ? " …" : ""}
              </p>
            ) : null}
          </details>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {definition && !definition.isDefault ? (
              <Button
                variant="ghost"
                size="sm"
                loading={reset.isPending}
                disabled={pending}
                onClick={() =>
                  reset.mutate(promptKey, {
                    onSuccess: () => setDirty(false),
                    onError: () => undefined,
                  })
                }
              >
                Reset to code default
              </Button>
            ) : null}
            <Button
              size="sm"
              loading={save.isPending}
              disabled={
                pending ||
                !dirty ||
                system.trim().length < 10 ||
                user.trim().length < 10
              }
              title={dirty ? undefined : "Nothing to save — this text matches the stored prompt"}
              onClick={() =>
                save.mutate(
                  {
                    key: promptKey,
                    label: definition?.label ?? promptKey,
                    systemText: system,
                    userTemplate: user,
                    temperature: Number(temperature) || 0.45,
                    maxTokens: maxTokens.trim() ? Number(maxTokens) : null,
                    reasoningEffort: (effort || null) as PromptDto["reasoningEffort"],
                    note: definition?.note ?? null,
                  },
                  { onSuccess: () => setDirty(false), onError: () => undefined },
                )
              }
            >
              Save prompt
            </Button>
          </div>

          {save.error || reset.error ? (
            <p className="text-xs text-danger">
              {((save.error ?? reset.error) as Error).message}
            </p>
          ) : null}
          {!dirty && definition ? (
            <p className="text-[11px] text-muted">
              {definition.isDefault
                ? "Unedited — saving here creates an override row in prompt_templates."
                : definition.updatedAt
                  ? `Saved `
                    + new Date(definition.updatedAt).toLocaleString()
                  : "Customized."}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
