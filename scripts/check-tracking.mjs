#!/usr/bin/env node
/**
 * `npm run check:tracking` — is email tracking actually wired up on *this*
 * database, right now?
 *
 * The dashboard degrades quietly by design (an un-migrated deploy must still
 * open), which means a tracking panel can read all zeroes for three different
 * reasons. This script asks the database directly and names the one it found.
 *
 * Read-only. The one RPC it calls is `record_tracking_event` with a token that
 * belongs to no message, which the function answers with `found:false` after
 * validating the shape — so it writes nothing. No email is sent, no secret is
 * printed, and nothing is created.
 */
import { readFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ── env ──────────────────────────────────────────────────────────────────
const file = ".env.local";
if (!existsSync(file)) {
  fail(`No ${file}. Copy .env.example to ${file} first.`);
}

const env = Object.fromEntries(
  readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);

const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
if (!url) fail("NEXT_PUBLIC_SUPABASE_URL is empty in " + file);
if (!key) fail("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY) is empty in " + file);

const headers = { apikey: key, Authorization: `Bearer ${key}` };
const results = [];

/** @type {"ok"|"missing"|"error"} */
function record(name, state, detail = "") {
  results.push({ name, state, detail });
  const mark = state === "ok" ? "\x1b[32m✓\x1b[0m" : state === "missing" ? "\x1b[33m✗\x1b[0m" : "\x1b[31m!\x1b[0m";
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path) {
  const response = await fetch(`${url}${path}`, { headers, cache: "no-store" });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* a non-JSON answer is itself the finding */
  }
  return { status: response.status, json, text };
}

console.log(`Project: ${url.replace(/^https?:\/\//, "")}\n`);

// ── 1. the tables ────────────────────────────────────────────────────────
for (const table of ["tracked_links", "tracking_events"]) {
  const { status, json } = await get(`/rest/v1/${table}?select=id&limit=1`);
  if (status === 200) record(`table public.${table}`, "ok");
  else if (status === 404) record(`table public.${table}`, "missing", "0005_email_tracking.sql not applied");
  else record(`table public.${table}`, "error", `${status} ${json?.message ?? ""}`.trim());
}

// ── 2. the columns the dashboard reads ───────────────────────────────────
const columns = [
  "tracking_token",
  "open_count",
  "click_count",
  "unique_click_count",
  "first_open_at",
  "last_event_at",
];
for (const column of columns) {
  const { status, json } = await get(`/rest/v1/email_logs?select=${column}&limit=1`);
  if (status === 200) record(`column email_logs.${column}`, "ok");
  else record(`column email_logs.${column}`, "missing", (json?.message ?? `HTTP ${status}`).slice(0, 90));
}

// ── 3. the RPCs, including their role guard ──────────────────────────────
const probe = randomBytes(24).toString("base64url");
// A GET cannot call an RPC, so POST with a token that belongs to no message:
// the function validates the shape, finds nothing, and answers found:false.
const recordProbe = await fetch(`${url}/rest/v1/rpc/record_tracking_event`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ p_kind: "open", p_token: probe, p_agent: "check:tracking", p_at: new Date().toISOString() }),
});
const recordBody = await recordProbe.json().catch(() => null);
if (recordProbe.status === 200 && recordBody?.found === false) {
  record("rpc record_tracking_event", "ok", "answers found:false for an unknown token, as designed");
} else if (isMissingFunction(recordBody)) {
  record("rpc record_tracking_event", "missing", "apply 0005_email_tracking.sql, then reload the API schema cache");
} else {
  record("rpc record_tracking_event", "error", `${recordProbe.status} ${JSON.stringify(recordBody).slice(0, 120)}`);
}

const outcome = await fetch(`${url}/rest/v1/rpc/record_log_outcome`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ p_log_id: "00000000-0000-4000-8000-000000000000", p_kind: "reply", p_at: new Date().toISOString() }),
});
const outcomeBody = await outcome.json().catch(() => null);
if (outcome.status === 200 && outcomeBody?.found === false) {
  record("rpc record_log_outcome", "ok");
} else if (isMissingFunction(outcomeBody)) {
  record("rpc record_log_outcome", "missing");
} else {
  record("rpc record_log_outcome", "error", `${outcome.status} ${JSON.stringify(outcomeBody).slice(0, 120)}`);
}

// ── 4. what the app is configured to do ─────────────────────────────────
const trackingOn = !/^false$/i.test(env.EMAIL_TRACKING || "") && env.EMAIL_PROVIDER !== "log";
record(
  "EMAIL_TRACKING effective for new sends",
  trackingOn ? "ok" : "missing",
  env.EMAIL_PROVIDER === "log" ? "EMAIL_PROVIDER=log: nothing is delivered, so nothing is tracked" : env.EMAIL_TRACKING || "unset (defaults on)",
);

const domain = (env.TRACKING_DOMAIN || env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
if (!domain) record("TRACKING_DOMAIN", "missing", "no origin to build pixel URLs from");
else if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(domain)) {
  record("TRACKING_DOMAIN", "missing", `${domain} is loopback — a recipient's client cannot reach it`);
} else if (domain.startsWith("http://")) {
  record("TRACKING_DOMAIN", "missing", `${domain} is not HTTPS — mail clients block mixed-content images`);
} else {
  record("TRACKING_DOMAIN", "ok", domain);
}

// ── 5. what already in the database looks like ──────────────────────────
const sample = await get(`/rest/v1/email_logs?select=id,to_email,status,tracking_token,open_count,click_count&order=created_at.desc&limit=5`);
if (sample.status === 200 && Array.isArray(sample.json)) {
  const tracked = sample.json.filter((row) => row.tracking_token).length;
  const opens = sample.json.reduce((sum, row) => sum + Number(row.open_count || 0), 0);
  record(
    "recent sends carry a pixel",
    tracked > 0 ? "ok" : "missing",
    `${tracked}/${sample.json.length} of the newest rows · ${opens} tracked open(s) recorded`,
  );
}

// ── summary ─────────────────────────────────────────────────────────────
const missing = results.filter((r) => r.state !== "ok");
console.log("");
if (missing.length === 0) {
  console.log("Everything is in place. New sends are tracked; existing rows keep their history.");
  console.log(`\nProve it from outside this machine: open ${domain}/api/health, then send a draft and check /emails.`);
} else {
  console.log(`${missing.length} check(s) did not pass:`);
  for (const item of missing) console.log(`  • ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
  console.log(
    "\nFix: apply supabase/migrations/0005_email_tracking.sql once in the Supabase SQL Editor,\n" +
      "then re-run this script. If the tables exist but the RPCs are still reported missing,\n" +
      "reload the PostgREST schema cache (Supabase → Settings → API → restart the project, or\n" +
      "run `notify pgrst, 'reload schema'` in the SQL editor).",
  );
  process.exitCode = 1;
}

/**
 * PostgREST answers a missing function with PGRST202 and a message that lists
 * what it searched for; the signature differs per function, the code does not.
 */
function isMissingFunction(body) {
  if (!body) return false;
  return body.code === "PGRST202" || /could not find the function|Searched for the function/i.test(body.message ?? "");
}

function fail(message) {
  console.error(`\x1b[31m${message}\x1b[0m`);
  process.exit(1);
}
