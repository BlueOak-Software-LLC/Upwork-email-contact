"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/** Server Action behind the topbar “Sign out” button. */
export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) logger.error("sign_out_failed", { error: error.message });
  redirect("/login");
}
