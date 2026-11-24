import type { CookieOptions } from "@supabase/ssr";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Keeps the Supabase auth cookies fresh on every request.
 *
 * It deliberately does NOT redirect on its own: the dashboard reads through our
 * own /api routes (service role), so it still works while you are wiring auth.
 * Flip `REQUIRE_SESSION` on to gate every non-public route behind /login.
 *
 * `/o/<token>.gif` and `/c/<token>` are in PUBLIC_PATHS because a mail client
 * has no session: the token in the URL is the only credential, and it is
 * single-purpose. Note that the matcher below already skips `*.gif`, so the
 * pixel route never reaches here — `/c/<token>` does, and must not bounce a
 * client's click to a login page.
 */
const REQUIRE_SESSION = false;

const PUBLIC_PATHS = ["/login", "/auth", "/api/health", "/api/email/send", "/o", "/c"];

/** Exported so the public surface stays testable when `REQUIRE_SESSION` flips. */
export function isPublic(pathname: string) {
  return (
    pathname === "/" ||
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  );
}

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response; // config errors surface in the app, not 500s here

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const { pathname } = request.nextUrl;

  if (REQUIRE_SESSION && !isPublic(pathname)) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      const login = request.nextUrl.clone();
      login.pathname = "/login";
      login.search = "";
      login.hash = "";
      return NextResponse.redirect(login);
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
