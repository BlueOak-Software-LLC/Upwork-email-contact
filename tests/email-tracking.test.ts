import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The send path with tracking wired in.
 *
 * What is asserted here is *ordering and content*, because that is what breaks
 * in the real world: the audit row must exist before the provider call (a pixel
 * fetched during the round-trip would otherwise have nothing to land on), the
 * token written into the HTML must be the token we stored, and a dry run must
 * mint nothing at all.
 *
 * The provider, the SMTP socket and the repositories are stubbed. The SQL rules
 * have their own suite (`tracking-sql.test.ts`) and the routes theirs.
 */

interface LogInsert {
  toEmail: string;
  subject: string;
  status: string;
  trackingToken?: string | undefined;
}

interface SentMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string | undefined;
}

interface StoredLink {
  token: string;
  destinationUrl: string;
  label: string;
}

/** Every dependency call in order, which is how "before the provider" is proven. */
const calls: string[] = [];

const open = vi.fn(async (_input: LogInsert): Promise<string | null> => "log-1");
const finalize = vi.fn(async (_id: string, _result: unknown): Promise<boolean> => true);
const create = vi.fn(async (_input: LogInsert): Promise<string | null> => "log-2");
const createLinks = vi.fn(
  async (_input: { logId: string; links: StoredLink[] }): Promise<number> => 1,
);
const markSent = vi.fn(async (_logId: string): Promise<void> => undefined);
const smtpSend = vi.fn(async (_input: unknown) => ({
  providerMessageId: "<smtp-1>",
  accepted: [],
}));
const providerSend = vi.fn(async (_message: SentMessage) => ({
  provider: "resend" as const,
  providerMessageId: "<rs-1>",
}));
const credentials = vi.fn(async (_id: string) => null);

vi.mock("@/server/db/email-logs.repo", () => ({
  emailLogsRepo: {
    open: async (input: unknown) => {
      calls.push("open");
      return open(input as LogInsert);
    },
    finalize: async (id: string, result: unknown) => {
      calls.push("finalize");
      return finalize(id, result);
    },
    create: async (input: unknown) => {
      calls.push("create");
      return create(input as LogInsert);
    },
  },
}));

vi.mock("@/server/db/tracking.repo", () => ({
  TRACKING_MIGRATION: "supabase/migrations/0005_email_tracking.sql",
  trackingRepo: {
    createLinks: async (input: unknown) => {
      calls.push("createLinks");
      return createLinks(input as { logId: string; links: StoredLink[] });
    },
    markSent: async (logId: string) => {
      calls.push("markSent");
      return markSent(logId);
    },
    record: vi.fn(),
    linkByToken: vi.fn(),
  },
}));

vi.mock("@/server/db/sender-accounts.repo", () => ({
  senderAccountsRepo: {
    credentials: (id: string) => credentials(id),
    incrementSent: vi.fn(async () => undefined),
    defaultAccountId: vi.fn(async () => null),
    getPublic: vi.fn(async () => null),
  },
}));

vi.mock("@/server/db/contacts.repo", () => ({
  contactsRepo: {
    byId: vi.fn(async () => null),
    markContacted: vi.fn(async () => undefined),
  },
}));

vi.mock("@/server/services/email-registry", () => ({
  resolveEmailProvider: () => ({
    name: "resend",
    send: async (message: unknown) => {
      calls.push("provider");
      return providerSend(message as SentMessage);
    },
  }),
}));

vi.mock("@/server/services/smtp.service", () => ({
  sendViaSmtp: async (input: unknown) => {
    calls.push("smtp");
    return smtpSend(input);
  },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const BASE_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-long-enough",
  SUPABASE_SERVICE_ROLE_KEY: "secret-key-long-enough-here",
  RESEND_API_KEY: "fake-key-for-tests-only",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "Outreach <hello@example.com>",
  TRACKING_DOMAIN: "https://track.example.com",
  EMAIL_TRACKING: "true",
  LINK_TRACKING: "true",
};

/**
 * `lib/env.ts` caches its parsed result per module instance, so each case needs
 * a fresh import graph with its own environment.
 */
async function loadService(overrides: Record<string, string> = {}) {
  // A fresh module graph per case, with a fresh environment: `lib/env.ts`
  // memoises the parsed values, so an old import would report old settings.
  vi.resetModules();
  Object.assign(process.env, BASE_ENV, { NODE_ENV: "test" }, overrides);
  return (await import("@/server/services/email.service")).sendEmail;
}

const message = (over: Record<string, unknown> = {}) =>
  ({
    to: "client@example.com",
    subject: "Proposal for your listing",
    text: "Hi there",
    updateContact: false,
    skipLog: false,
    ...over,
  }) as never;

beforeEach(() => {
  calls.length = 0;
  for (const mock of [
    open,
    finalize,
    create,
    createLinks,
    markSent,
    smtpSend,
    providerSend,
    credentials,
  ]) {
    mock.mockClear();
  }
  open.mockImplementation(async () => "log-1");
  createLinks.mockImplementation(async () => 1);
  providerSend.mockImplementation(async () => ({
    provider: "resend",
    providerMessageId: "<rs-1>",
  }));
});

const firstInsert = () => open.mock.calls[0]![0];
const firstSent = () => providerSend.mock.calls[0]![0];

describe("sendEmail · tracking on", () => {
  it("opens the audit row with its token before the provider is called", async () => {
    const sendEmail = await loadService();
    const results = await sendEmail(message());

    expect(calls.slice(0, 2)).toEqual(["open", "provider"]);
    expect(firstInsert().status).toBe("queued");
    expect(firstInsert().trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(results[0]!.tracked).toBe(true);
    expect(results[0]!.pixelUrl).toBe(
      `https://track.example.com/o/${firstInsert().trackingToken}.gif`,
    );
  });

  it("puts exactly the stored token in the pixel of the delivered HTML", async () => {
    const sendEmail = await loadService();
    await sendEmail(message());

    const token = firstInsert().trackingToken!;
    expect(firstSent().html).toContain(`<img src="https://track.example.com/o/${token}.gif"`);
    // The text alternative carries no pixel: it cannot render one.
    expect(firstSent().text).not.toContain("/o/");
  });

  it("gives every recipient their own token, so an open identifies a person", async () => {
    const sendEmail = await loadService();
    const results = await sendEmail(message({ to: ["a@example.com", "b@example.com"] }));

    const tokens = open.mock.calls.map((call) => call[0].trackingToken!);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens).size).toBe(2);
    expect(results[0]!.pixelUrl).toBe(`https://track.example.com/o/${tokens[0]}.gif`);
    expect(results[1]!.pixelUrl).toBe(`https://track.example.com/o/${tokens[1]}.gif`);

    // Each recipient's message carries their own pixel and not the other's.
    expect(open.mock.calls[0]![0].toEmail).toBe("a@example.com");
    expect(open.mock.calls[1]![0].toEmail).toBe("b@example.com");
    const firstHtml = (providerSend.mock.calls[0]![0] as { html?: string }).html ?? "";
    const secondHtml = (providerSend.mock.calls[1]![0] as { html?: string }).html ?? "";
    expect(firstHtml).toContain(tokens[0]);
    expect(firstHtml).not.toContain(tokens[1]!);
    expect(secondHtml).toContain(tokens[1]);
  });

  it("rewrites a URL in the body to /c/<token>, storing the link first", async () => {
    const sendEmail = await loadService();
    await sendEmail(
      message({ text: "See https://acme.example.com/portfolio for the work." }),
    );

    expect(calls).toEqual(["open", "createLinks", "provider", "finalize", "markSent"]);

    const stored = createLinks.mock.calls[0]![0];
    expect(stored.logId).toBe("log-1");
    expect(stored.links).toHaveLength(1);
    expect(stored.links[0]!.destinationUrl).toBe("https://acme.example.com/portfolio");
    expect(stored.links[0]!.label).toBe("acme.example.com/portfolio");

    const html = (firstSent() as { html?: string }).html ?? "";
    expect(html).toContain(`href="https://track.example.com/c/${stored.links[0]!.token}"`);
    // The readable part keeps the real destination.
    expect(firstSent().text).toContain("https://acme.example.com/portfolio");
  });

  it("drops a destination that fails the guard instead of shipping a redirect to it", async () => {
    const sendEmail = await loadService();
    await sendEmail(
      message({
        text: "Details at https://169.254.169.254/latest/meta-data/ and https://acme.example.com/x",
      }),
    );

    expect(createLinks.mock.calls[0]![0].links.map((l) => l.destinationUrl)).toEqual([
      "https://acme.example.com/x",
    ]);
  });

  it("finalizes with a claim, so a racing duplicate cannot rewrite the first row", async () => {
    const sendEmail = await loadService();
    await sendEmail(message());

    // finalize() only updates a row still sitting in `queued`.
    expect(finalize).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "sent", provider: "resend" }),
    );
    expect(markSent).toHaveBeenCalledWith("log-1");
  });

  it("stamps the row failed when the provider refuses, and still throws for an all-failed call", async () => {
    const sendEmail = await loadService();
    providerSend.mockRejectedValueOnce(new Error("mailbox unavailable"));

    await expect(sendEmail(message())).rejects.toThrow(/rejected every recipient/);

    expect(finalize).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ status: "failed", error: "mailbox unavailable" }),
    );
    // The failed row keeps its token: if the provider took the message after
    // all and only the response was lost, an open still resolves to this send.
    expect(firstInsert().trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(markSent).not.toHaveBeenCalled();
  });
});

describe("sendEmail · tracking must stay off", () => {
  it("mints nothing in log mode, even with EMAIL_TRACKING=true", async () => {
    const sendEmail = await loadService({ EMAIL_PROVIDER: "log" });
    await sendEmail(message({ text: "See https://acme.example.com/x" }));

    expect(firstInsert().trackingToken).toBeUndefined();
    expect(calls).not.toContain("createLinks");
    expect(calls).not.toContain("markSent");
    expect((firstSent() as { html?: string }).html).not.toContain("/o/");
  });

  it("mints nothing when the switch is off", async () => {
    const sendEmail = await loadService({ EMAIL_TRACKING: "false" });
    await sendEmail(message());
    expect(firstInsert().trackingToken).toBeUndefined();
  });

  it("mints nothing when the caller skips the audit row — an ownerless pixel is a lie", async () => {
    const sendEmail = await loadService();
    const results = await sendEmail(message({ skipLog: true }));

    expect(calls).toEqual(["provider"]);
    expect(results[0]!.tracked).toBe(false);
    // No token means no pixel: nothing unattributable goes into an inbox.
    expect((firstSent() as { html?: string }).html).not.toContain("/o/");
  });

  it("honours an explicit track:false for one send", async () => {
    const sendEmail = await loadService();
    await sendEmail(message(), { track: false });

    expect(firstInsert().trackingToken).toBeUndefined();
    expect((firstSent() as { html?: string }).html).not.toContain("/o/");
  });

  it("leaves links alone when LINK_TRACKING=false but still tracks opens", async () => {
    const sendEmail = await loadService({ LINK_TRACKING: "false" });
    await sendEmail(message({ text: "See https://acme.example.com/x" }));

    expect(calls).not.toContain("createLinks");
    const html = (firstSent() as { html?: string }).html ?? "";
    expect(html).toContain("/o/");
    expect(html).not.toContain("/c/");
  });

  it("keeps caller-supplied html verbatim when tracking is off", async () => {
    const sendEmail = await loadService({ EMAIL_TRACKING: "false" });
    await sendEmail({ to: "client@example.com", subject: "s", html: "<p>custom <b>html</b></p>", skipLog: false } as never);

    expect((firstSent() as { html?: string }).html).toBe("<p>custom <b>html</b></p>");
  });
});

describe("sendEmail · when the audit row cannot be written", () => {
  it("still sends, and records the delivery afterwards", async () => {
    const sendEmail = await loadService();
    open.mockResolvedValue(null);

    const results = await sendEmail(message());

    expect(calls).toContain("provider");
    expect(calls).toContain("create");
    expect(results[0]!.status).toBe("sent");
    expect(results[0]!.id).toBe("log-2");
    // Untracked from here: no row means nothing can own the token.
    expect(results[0]!.tracked).toBe(false);
  });

  it("still delivers when opening the row throws", async () => {
    const sendEmail = await loadService();
    open.mockRejectedValue(new Error("connection reset"));

    const results = await sendEmail(message());

    expect(calls).toContain("provider");
    expect(results[0]!.status).toBe("sent");
    expect(results[0]!.tracked).toBe(false);
  });

  it("still delivers when storing the links throws", async () => {
    const sendEmail = await loadService();
    createLinks.mockRejectedValueOnce(new Error("schema cache miss"));

    const results = await sendEmail(message({ text: "See https://acme.example.com/x" }));
    expect(results[0]!.status).toBe("sent");
  });
});
