/**
 * The model catalogue both the server and the settings page read.
 *
 * Deliberately dependency-free: the settings page is a client component, and
 * importing the server env module (or the DB repo) from it would pull secrets
 * and `server-only` into the browser bundle.
 *
 * The defaults are chosen for *free* operation at upper-middle quality:
 *
 * - **Puter** `…:free` variants are the only Puter models with no per-token
 *   charge. The 550B Nemotron Ultra is the largest free text model in Puter's
 *   catalogue (1M context, 64K output), which matters for a 12k-token PPD.
 * - **Groq** `openai/gpt-oss-120b` is the strongest model on the developer
 *   free tier. It is rate-limited (8k TPM on a fresh key), not metered — so it
 *   is "free" in the sense the user asked for, with the ceiling documented.
 * - **Gemini** stays on `gemini-3.8-flash`, the current free-tier Flash
 *   workhorse (1M input / 64K output); it is the third fallback and is skipped
 *   when no key exists.
 */

export const AI_PROVIDER_IDS = ["puter", "groq", "gemini"] as const;

export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export function isAiProviderId(value: unknown): value is AiProviderId {
  return typeof value === "string" && (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

/** The order the user asked for: Puter first, then Groq, then Gemini. */
export const DEFAULT_PROVIDER_ORDER = "puter,groq,gemini";

export interface ModelPreset {
  id: string;
  label: string;
  note: string;
  free: boolean;
}

export interface AiProviderMeta {
  id: AiProviderId;
  label: string;
  /** What the credential is called in this provider's own documentation. */
  credentialLabel: string;
  envVar: "PUTER_AUTH_TOKEN" | "GROQ_API_KEY" | "GEMINI_API_KEY";
  /** Where the operator signs up / copies the credential from. */
  credentialUrl: string;
  defaultModel: string;
  defaultFallbackModel: string | null;
  presets: ModelPreset[];
}

export const AI_PROVIDER_META: Record<AiProviderId, AiProviderMeta> = {
  puter: {
    id: "puter",
    label: "Puter",
    credentialLabel: "Puter auth token",
    envVar: "PUTER_AUTH_TOKEN",
    credentialUrl: "https://puter.com/",
    defaultModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
    defaultFallbackModel: "openrouter:nvidia/nemotron-3.5-lightning:free",
    presets: [
      {
        id: "openrouter:nvidia/nemotron-3-ultra-550b-a55b:free",
        label: "Nemotron 3 Ultra 550B (free)",
        note: "1M context · 64K output · largest free text model in Puter's catalogue",
        free: true,
      },
      {
        id: "openrouter:nvidia/nemotron-3.5-lightning:free",
        label: "Nemotron 3.5 Lightning (free)",
        note: "1M context · 64K output · faster fallback for the same free tier",
        free: true,
      },
      {
        id: "openrouter:particle-ai/particle-1:free",
        label: "Particle 1 (free)",
        note: "1M context · 131K output · long-form free option",
        free: true,
      },
      {
        id: "openrouter:google/gemma-4-31b-it:free",
        label: "Gemma 4 31B (free)",
        note: "262K context · 32K output · light and free",
        free: true,
      },
      {
        id: "anthropic/claude-sonnet-5-5",
        label: "Claude Sonnet 5.5 (paid)",
        note: "Highest quality, billed to the Puter account — not free",
        free: false,
      },
    ],
  },
  groq: {
    id: "groq",
    label: "Groq",
    credentialLabel: "Groq API key",
    envVar: "GROQ_API_KEY",
    credentialUrl: "https://console.groq.com/keys",
    defaultModel: "openai/gpt-oss-120b",
    defaultFallbackModel: null,
    presets: [
      {
        id: "openai/gpt-oss-120b",
        label: "GPT-OSS 120B (free tier)",
        note: "Best free-tier quality · 131K context · ~8K tokens/minute on a fresh key",
        free: true,
      },
      {
        id: "openai/gpt-oss-20b",
        label: "GPT-OSS 20B (free tier)",
        note: "Faster and lighter · still free · lower ceiling on quality",
        free: true,
      },
      {
        id: "qwen/qwen3.8-27b",
        label: "Qwen 3.8 27B (free tier)",
        note: "Alternative free-tier model if GPT-OSS is rate-limited",
        free: true,
      },
    ],
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    credentialLabel: "Gemini API key",
    envVar: "GEMINI_API_KEY",
    credentialUrl: "https://aistudio.google.com/apikey",
    defaultModel: "gemini-3.8-flash",
    defaultFallbackModel: null,
    presets: [
      {
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash (free tier)",
        note: "Current free-tier workhorse · fast · good JSON compliance",
        free: true,
      },
      {
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash Lite (free tier)",
        note: "Cheapest/fastest free option · lower quality",
        free: true,
      },
      {
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro (preview, limited)",
        note: "Stronger reasoning · much smaller free quota",
        free: true,
      },
    ],
  },
};

/** Parse `AI_PROVIDER_ORDER`; unknown tokens are dropped rather than throwing. */
export function parseProviderOrder(value: string | null | undefined): AiProviderId[] {
  const seen = new Set<AiProviderId>();
  const order: AiProviderId[] = [];
  for (const raw of (value ?? "").split(",")) {
    const token = raw.trim().toLowerCase();
    if (isAiProviderId(token) && !seen.has(token)) {
      seen.add(token);
      order.push(token);
    }
  }
  return order.length ? order : [...AI_PROVIDER_IDS];
}
