import { updateSession } from "@/lib/supabase/middleware";
import type { NextRequest } from "next/server";

export { config } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}
