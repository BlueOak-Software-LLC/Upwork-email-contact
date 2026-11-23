import "server-only";
import { getServerEnv } from "@/lib/env";

export function groqConfig() {
  const env = getServerEnv();
  return {
    apiKey: env.GROQ_API_KEY ?? "",
    model: env.GROQ_MODEL,
    timeoutMs: env.GROQ_TIMEOUT_MS,
    language: env.PROPOSAL_LANGUAGE,
    baseUrl: "https://api.groq.com/openai/v1",
  };
}

export function pdfConfig() {
  const env = getServerEnv();
  return {
    provider: env.PDF_PROVIDER,
    templatePath: env.PDFME_TEMPLATE_PATH,
  };
}
