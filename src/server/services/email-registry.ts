import { getServerEnv } from "@/lib/env";
import type { EmailProvider } from "./email-providers/types";
import {
  logProvider,
  resendProvider,
  smtpProvider,
} from "./email-providers";

let cached: { name: string; provider: EmailProvider } | null = null;

/** Selects the adapter from EMAIL_PROVIDER and memoises per isolate. */
export function resolveEmailProvider(): EmailProvider {
  const { EMAIL_PROVIDER } = getServerEnv();
  if (cached?.name === EMAIL_PROVIDER) return cached.provider;

  const provider =
    EMAIL_PROVIDER === "resend"
      ? resendProvider
      : EMAIL_PROVIDER === "smtp"
        ? smtpProvider
        : logProvider;

  cached = { name: EMAIL_PROVIDER, provider };
  return provider;
}
