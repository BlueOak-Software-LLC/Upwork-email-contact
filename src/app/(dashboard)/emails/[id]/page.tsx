import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { emailLogsRepo } from "@/server/db/email-logs.repo";
import { trackingRepo } from "@/server/db/tracking.repo";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { CopyButton } from "@/components/ui/copy-button";
import { Table, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { EVENT_LABELS, TRACKING_TONE, describeOpens, trackingStateLabel, trackingStateOf } from "@/lib/tracking";
import { truncate } from "@/lib/utils";
import { RecordOutcome } from "@/components/tracking/record-outcome";
import { LiveRefresh } from "@/components/layout/live-refresh";
import { trackingPixelHint } from "@/server/queries";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Message activity" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EmailActivityPage({ params }: PageProps) {
  const { id: raw } = await params;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!id) notFound();

  const log = await emailLogsRepo.byId(id).catch(() => null);
  if (!log) {
    return (
      <div className="card">
        <EmptyState
          tone="danger"
          icon="✕"
          title="This message is not in the delivery log"
          description={
            <>
              Deleting a lead keeps <code>email_logs</code> on purpose, so a missing row means it
              was never sent, or the id is wrong.{" "}
              <Link href="/emails" className="text-brand hover:underline">
                Back to the log →
              </Link>
            </>
          }
        />
      </div>
    );
  }

  const [links, events] = await Promise.all([
    trackingRepo.linksForLog(id).catch(() => []),
    trackingRepo.eventsForLog(id, 100).catch(() => []),
  ]);

  const state = trackingStateOf(log);
  const tracked = Boolean(log.tracking_token);

  return (
    <div className="space-y-4">
      <LiveRefresh intervalMs={30_000} throttleMs={15_000} />

      <Link href="/emails" className="text-xs text-brand hover:underline">
        ← All messages
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-medium">{log.subject}</h2>
            <p className="mt-1 text-xs text-muted">
              to <span className="text-ink">{log.to_email}</span>
              <CopyButton value={log.to_email} size="icon" label="Copy recipient" />
              <span className="mx-2">·</span>from <span className="text-ink">{log.from_email}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={log.status} />
            <Badge tone={TRACKING_TONE[state]}>{trackingStateLabel(state)}</Badge>
          </div>
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Opens"
            value={tracked ? String(log.open_count) : "—"}
            hint={tracked ? describeOpens(Number(log.open_count)) : "no pixel in this message"}
          />
          <Stat
            label="Clicks"
            value={tracked ? String(log.click_count) : "—"}
            hint={
              tracked
                ? `${log.unique_click_count} of ${links.length || 0} link${links.length === 1 ? "" : "s"}`
                : "link tracking was off"
            }
          />
          <Stat label="First open" value={when(log.first_open_at)} />
          <Stat label="Last activity" value={when(log.last_event_at ?? log.sent_at)} />
        </dl>

        {tracked ? (
          <p className="mt-3 text-[11px] text-muted/80">
            Pixel address <code>{trackingPixelHint(log.tracking_token)}</code> — it only counts if
            the recipient could reach this deployment.{" "}
            <Link href="/settings/tracking" className="text-brand hover:underline">
              Tracking settings →
            </Link>
          </p>
        ) : (
          <p className="mt-3 text-[11px] text-warn">
            This row has no <code>tracking_token</code>: it was sent before{" "}
            <code>0005_email_tracking.sql</code> was applied, or with{" "}
            <code>EMAIL_TRACKING=false</code>. Past messages cannot be tracked retroactively — the
            pixel has to be inside the bytes that were delivered.
          </p>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <h3 className="text-sm font-medium">Activity</h3>
            <span className="text-[11px] text-muted">latest {events.length}</span>
          </div>
          {events.length === 0 ? (
            <EmptyState
              title="Nothing recorded yet"
              description={
                tracked
                  ? "No pixel request and no click. Either nobody opened it, or the address in TRACKING_DOMAIN is not reachable from the recipient's mail client."
                  : "This message was sent untracked."
              }
            />
          ) : (
            <Table>
              <THead>
                <Tr>
                  <Th>Event</Th>
                  <Th>Detail</Th>
                  <Th>When</Th>
                </Tr>
              </THead>
              <TBody>
                {events.map((event) => (
                  <Tr key={event.id}>
                    <Td className="font-medium">
                      {EVENT_LABELS[event.event_type] ?? event.event_type}
                    </Td>
                    <Td className="text-xs text-muted">
                      {event.event_type === "click" ? (
                        <span className="flex flex-wrap items-center gap-1">
                          <span className="text-ink">{event.link?.label || "link"}</span>
                          {event.link?.destination_url ? (
                            <a
                              href={event.link.destination_url}
                              target="_blank"
                              rel="noreferrer nofollow"
                              className="underline decoration-line underline-offset-2 hover:text-ink"
                            >
                              {truncate(event.link.destination_url, 44)}
                            </a>
                          ) : null}
                        </span>
                      ) : (
                        <span>{describeAgent(event.user_agent)}</span>
                      )}
                    </Td>
                    <Td className="text-xs text-muted tabular">
                      {new Date(event.occurred_at).toLocaleString()}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>

        <div className="space-y-4">
          <div className="card p-5">
            <h3 className="text-sm font-medium">Delivery</h3>
            <dl className="mt-3 space-y-2 text-xs">
              <Row label="Provider">{log.provider}</Row>
              <Row label="Message id">
                <span className="break-all font-mono text-[11px]">
                  {log.provider_message_id ?? "—"}
                </span>
              </Row>
              <Row label="Sent">{when(log.sent_at)}</Row>
              <Row label="Logged">{when(log.created_at)}</Row>
              {log.error ? (
                <div className="rounded-lg border border-danger/30 bg-danger/8 p-2 text-danger">
                  {log.error}
                </div>
              ) : null}
            </dl>
          </div>

          <div className="card p-5">
            <h3 className="text-sm font-medium">What happened next</h3>
            <p className="mt-1 text-[11px] text-muted">
              This app never reads your mailbox, so replies and meetings are recorded by hand. Do it
              — reply rate is the number the outreach is judged on.
            </p>
            <div className="mt-3">
              <RecordOutcome logId={id} />
            </div>
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h3 className="text-sm font-medium">Tracked links</h3>
          <span className="text-[11px] text-muted">
            {links.length ? `${links.length} in this message` : "none"}
          </span>
        </div>
        {links.length === 0 ? (
          <EmptyState
            title="No tracked links"
            description={
              tracked
                ? "The body had no http(s) URL to rewrite, so this message records opens only. That is normal for a first-touch Upwork note."
                : "Untracked sends mint no links."
            }
          />
        ) : (
          <Table>
            <THead>
              <Tr>
                <Th>Label</Th>
                <Th>Destination</Th>
                <Th>Clicks</Th>
                <Th>First / last</Th>
              </Tr>
            </THead>
            <TBody>
              {links.map((link) => (
                <Tr key={link.id}>
                  <Td className="font-medium">{link.label}</Td>
                  <Td className="text-xs">
                    <a
                      href={link.destination_url}
                      target="_blank"
                      rel="noreferrer nofollow"
                      className="underline decoration-line underline-offset-2 hover:text-ink"
                    >
                      {truncate(link.destination_url, 60)}
                    </a>
                  </Td>
                  <Td className="tabular">{link.click_count}</Td>
                  <Td className="text-[11px] text-muted">
                    {when(link.first_click_at, "—")}
                    {link.last_click_at ? ` · ${when(link.last_click_at)}` : ""}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
        <p className="border-t border-line px-5 py-3 text-[11px] text-muted/80">
          These are the addresses the recipient actually clicked; the destination opens in a new tab
          for you without recording a click, because the redirect is what counts and this is our own
          browser.
        </p>
      </div>

      <div className="card p-5">
        <h3 className="text-sm font-medium">What was sent</h3>
        <details className="mt-2">
          <summary className="cursor-pointer list-none text-xs text-muted hover:text-ink">
            {truncate(log.body_text, 90)}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-canvas p-3 font-sans text-[11px] text-ink/80">
            {log.body_text}
          </pre>
        </details>
        <p className="mt-2 text-[11px] text-muted/70">
          The plain-text alternative as delivered. The tracking pixel lives in the HTML part, which is
          why a text-only client shows nothing here and records no open.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-faint">{label}</dt>
      <dd className="text-2xl font-semibold tabular">{value}</dd>
      {hint ? <dd className="text-[11px] text-muted">{hint}</dd> : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink/90">{children}</dd>
    </div>
  );
}

function when(value: string | null | undefined, fallback = "—"): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleString();
}

/**
 * A browser fingerprint, not an identity: no IP address is ever stored, and the
 * string is what the client chose to send. It is shown because "Mozilla/5.0 …
 * Safari/604.30.6" reads as a device class, which is the only clue available to
 * tell a proxy fetch from a phone.
 */
function describeAgent(agent: string | null): string {
  if (!agent) return "no client hint";
  const ua = agent.toLowerCase();
  const client = ua.includes("outlook")
    ? "Outlook"
    : ua.includes("thunderbird")
      ? "Thunderbird"
      : ua.includes("gmailandroid") || ua.includes("googleimageproxy")
        ? "Gmail proxy"
        : ua.includes("iphone") || ua.includes("ipad")
          ? "Apple mail"
          : ua.includes("android")
            ? "Android mail"
            : ua.includes("curl") || ua.includes("python") || ua.includes("bot")
              ? "automated request"
              : ua.includes("mozilla")
                ? "desktop browser"
                : "unknown client";
  return `${client}${agent.length > 40 ? " · recorded verbatim" : ` · ${agent.slice(0, 40)}`}`;
}
