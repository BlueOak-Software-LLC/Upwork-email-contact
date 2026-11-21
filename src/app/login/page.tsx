"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

/**
 * Passwordless magic-link sign-in.
 * `redirectTo` must be listed in Supabase → Auth → URL Configuration.
 */
export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err) throw err;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the link");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold">Sign in</h1>
          <p className="text-sm text-muted">
            We email you a magic link — no passwords stored here.
          </p>
        </div>

        <Field label="Work email">
          <Input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
          />
        </Field>

        {sent ? (
          <p className="rounded-lg bg-brand/10 p-3 text-sm text-brand">
            Check {email} for the login link.
          </p>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}

        <Button type="submit" className="w-full justify-center" loading={loading}>
          Send magic link
        </Button>
      </form>
    </main>
  );
}
