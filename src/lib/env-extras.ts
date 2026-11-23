import "server-only";
import { getServerEnv } from "@/lib/env";

export function groqConfig() {
  const env = getServerEnv();
  return {
    apiKey: env.GROQ_API_KEY ?? "",
    model: env.GROQ_MODEL,
    timeoutMs: env.GROQ_TIMEOUT_MS,
    /** Completion cap for the combined PPD + email call (see README §5). */
    maxTokens: env.GROQ_MAX_TOKENS,
    /** TPM allowance used to clamp a request that Groq would otherwise reject. */
    tokensPerMinute: env.GROQ_TOKENS_PER_MINUTE,
    /** Sent as `reasoning_effort` — GPT-OSS bills thinking tokens here too. */
    reasoningEffort: env.GROQ_REASONING_EFFORT,
    language: env.PROPOSAL_LANGUAGE,
    pricesPerMillion: {
      input: env.GROQ_PRICE_INPUT_PER_M,
      output: env.GROQ_PRICE_OUTPUT_PER_M,
    },
    baseUrl: "https://api.groq.com/openai/v1",
  };
}

/** USD the reported usage would have cost, rounded to 6 decimals. */
export function estimateGroqCost(usage: {
  prompt_tokens: number;
  completion_tokens: number;
}) {
  const { input, output } = groqConfig().pricesPerMillion;
  const usd =
    (usage.prompt_tokens / 1_000_000) * input + (usage.completion_tokens / 1_000_000) * output;
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * Who "we" are on the proposal. Everything here overrides model output, so a
 * hallucinated company name or reply address can never reach a client.
 */
export function brandConfig() {
  const env = getServerEnv();
  const from = parseFrom(env.EMAIL_FROM);
  const company = env.PROPOSAL_COMPANY || from.displayName || personify(from.local) || "Our studio";
  return {
    company,
    website: env.PROPOSAL_WEBSITE,
    preparedBy: env.PROPOSAL_PREPARED_BY || company,
    senderEmail: from.email || env.EMAIL_FROM,
    rate: env.PROPOSAL_RATE,
  };
}

/** `"Your Studio" <studio.hello@x.com>` → { displayName, email, local, domain }. */
function parseFrom(value: string) {
  const match = /^(?:"([^"]+)"|([^<]+))?\s*<([^>]+)>$/.exec(value.trim());
  const email = (match?.[3] ?? value).trim();
  const [local = "", domain = ""] = email.split("@");
  return {
    displayName: (match?.[1] ?? match?.[2] ?? "").trim(),
    email: email.includes("@") ? email : "",
    local,
    domain,
  };
}

/**
 * Bare address with no display name (`me@gmail.com`) still shouldn't brand the
 * PDF as "gmail.com" — use the local part as a name-ish fallback instead.
 */
function personify(local: string) {
  return local
    .replace(/[._+-]+/g, " ")
    .replace(/\d+$/, "")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function pdfConfig() {
  const env = getServerEnv();
  return {
    provider: env.PDF_PROVIDER,
    /**
     * Reference copy of one compiled document (import it into the PDFme
     * Designer to re-style). Runtime templates are generated per proposal by
     * `lib/pdfme/compiler.ts`.
     */
    templatePath: env.PDFME_TEMPLATE_PATH,
  };
}
