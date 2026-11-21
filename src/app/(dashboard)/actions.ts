"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** Server Action behind the topbar “Sign out” button. */
export async function signOut() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) console.error("signOut failed", error.message);
  redirect("/login");
}
