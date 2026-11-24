/**
 * The two ways a payload identifies its job — `job_id` and the job link — and
 * how to tell they point at the same post.
 *
 * Upwork is the reason this file exists. A job's URL is
 * `https://www.upwork.com/jobs/~021234567890abcdef` while its `job_id` is
 * `1234567890abcdef`: the link carries a `~02` prefix, a tracking query string
 * that changes per viewer, and sometimes a slug instead of an id. Two scrapes of
 * the same post therefore arrive with different-looking values, and a dedupe
 * that compares the strings verbatim files the lead twice.
 *
 * Everything here is pure and total: no throwing, no network, no database.
 */

/** Query keys that carry tracking noise rather than job identity. */
const TRACKING_PARAMS = /^(utm_|src$|src2$|ref$|ref_id$|tracking$|t$|cid$|si$|feature$|shared$)/i;

/** Query keys whose value *is* the job, on sites that route that way. */
const ID_PARAMS = /^(job_?id|jobid|id|job)$/i;

const UPWORK_ID_IN_PATH = /\/jobs\/~?([0-9a-z]{6,40})/i;
const NUMERIC_ID_IN_PATH = /\/(?:job|jobs|project|projects|listing)\/(\d{5,20})(?:[/?#]|$)/i;

/**
 * Canonical form of a job link: lowercase scheme+host, no `www.`, no fragment,
 * no tracking parameters, no trailing slash. Identity parameters are kept.
 *
 * Returns `""` for anything that is not a URL, so callers can treat an empty
 * result as "no usable link" rather than a second shape to compare.
 */
export function normalizeJobUrl(value: string | null | undefined): string {
  const raw = (value ?? "").trim();
  if (!raw) return "";

  // A link with some other scheme is not a job reference: `ftp://x/y` must not
  // be read as the host `ftp`, so reject an explicit scheme before adding one.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1];
  if (scheme && !/^https?$/i.test(scheme)) return "";

  // Accept a bare `upwork.com/jobs/...` the way a browser address bar does.
  const candidate = scheme ? raw : `https://${raw.replace(/^\/+/, "")}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol)) return "";

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "");

  const kept = [...url.searchParams.entries()].filter(
    ([key]) => ID_PARAMS.test(key) || !TRACKING_PARAMS.test(key),
  );
  const query = kept
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${val}`)
    .join("&");

  return `${url.protocol.replace(":", "").toLowerCase()}://${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * The job id a link implies, or `null`.
 *
 * Upwork embeds it after `~02`; other boards use `/job/12345678` or
 * `?job_id=12345678`. This is what lets a payload that only carries a link
 * match a stored lead that arrived with an id.
 */
export function jobIdFromUrl(value: string | null | undefined): string | null {
  const normalized = normalizeJobUrl(value);
  if (!normalized) return null;

  const upwork = UPWORK_ID_IN_PATH.exec(normalized)?.[1];
  if (upwork) return normalizeJobId(upwork);

  const numeric = NUMERIC_ID_IN_PATH.exec(normalized)?.[1];
  if (numeric) return numeric;

  try {
    const params = new URL(normalized).searchParams;
    for (const [key, val] of params.entries()) {
      if (ID_PARAMS.test(key) && val.trim()) return normalizeJobId(val);
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The id as it is actually stored: `~02…` is Upwork's link prefix, not part of
 * the identifier, and payloads arrive with stray spaces and casing.
 */
export function normalizeJobId(value: string | number | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^~/, "")
    .replace(/^02(?=[0-9a-z]{6,})/i, "")
    .toLowerCase();
}

/**
 * Every link form a stored row might hold for this payload, most canonical
 * first: the normalized URL, then the raw string as it arrived (rows written
 * before this normalisation existed keep their original text).
 */
export function jobUrlCandidates(value: string | null | undefined): string[] {
  const raw = (value ?? "").trim();
  const normalized = normalizeJobUrl(raw);
  return [...new Set([normalized, raw].filter(Boolean))];
}

/** Same idea for ids: the payload's, and the one its link implies. */
export function jobIdCandidates(parts: {
  jobId?: string | null;
  jobUrl?: string | null;
}): string[] {
  const fromId = normalizeJobId(parts.jobId);
  const fromUrl = normalizeJobId(jobIdFromUrl(parts.jobUrl) ?? "");
  return [...new Set([fromId, fromUrl].filter(Boolean))];
}
