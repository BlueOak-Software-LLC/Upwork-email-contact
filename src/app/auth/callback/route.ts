import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** Supabase magic-link / OAuth redirect target (PKCE code exchange). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeNext(searchParams.get("next"), origin);

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(next);
  }

  return NextResponse.redirect(`${origin}/login?error=invalid-or-expired-link`);
}

function safeNext(next: string | null, origin: string) {
  if (!next) return origin;
  try {
    return new URL(next, origin).origin === origin ? next : origin;
  } catch {
    return origin;
  }
}
