import { describe, expect, it } from "vitest";
import {
  buildTrackedHtml,
  normalizeDestination,
  stripTrackingPixels,
} from "@/server/services/tracking/build";
import { discoverLinks, labelFor } from "@/server/services/tracking/links";
import { validateDestination } from "@/server/services/tracking/urls";
import { clickUrl, isToken, mintToken, pixelUrl, TRANSPARENT_GIF } from "@/server/services/tracking/token";
import { textToHtml } from "@/server/services/templates";

/**
 * The body-building rules, tested as pure functions.
 *
 * These matter because a mistake here is invisible until a client has the
 * message: a missing pixel means no opens ever, and a pixel that survives a
 * preview means our own dashboard inflates the numbers.
 */

const DOMAIN = "https://track.example.com";
const TOKEN = "TokenForTesting0123456789abcdef";

function link(destinationUrl: string, token = "LinkToken0123456789abcdefghijKl", label = "Portfolio") {
  return { token, destinationUrl, label };
}

describe("mintToken / isToken", () => {
  it("produces 32 base64url characters with no padding", () => {
    for (let index = 0; index < 200; index += 1) {
      const token = mintToken();
      expect(token).toHaveLength(32);
      expect(token).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      expect(token).not.toMatch(/[+/=]/);
    }
  });

  it("never repeats itself", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintToken()));
    expect(seen.size).toBe(500);
  });

  it("accepts only the shape the SQL guard accepts", () => {
    expect(isToken(TOKEN)).toBe(true);
    expect(isToken("short")).toBe(false);
    expect(isToken("with space and!marks")).toBe(false);
    expect(isToken("x".repeat(129))).toBe(false);
    expect(isToken(null)).toBe(false);
    expect(isToken(undefined)).toBe(false);
  });

  it("builds the two public addresses", () => {
    expect(pixelUrl(DOMAIN, TOKEN)).toBe(`${DOMAIN}/o/${TOKEN}.gif`);
    expect(clickUrl(DOMAIN, TOKEN)).toBe(`${DOMAIN}/c/${TOKEN}`);
    expect(pixelUrl(`${DOMAIN}/`, TOKEN)).toBe(`${DOMAIN}/o/${TOKEN}.gif`);
  });

  it("serves a real 1×1 GIF89a", () => {
    expect([...TRANSPARENT_GIF.slice(0, 6)]).toEqual([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    // Logical screen descriptor, little-endian uint16 at byte 6 (w) and 8 (h).
    expect(TRANSPARENT_GIF.readUInt16LE(6)).toBe(1);
    expect(TRANSPARENT_GIF.readUInt16LE(8)).toBe(1);
  });
});

describe("validateDestination", () => {
  it("accepts ordinary public URLs", () => {
    for (const url of [
      "https://acme.com",
      "http://example.org/a/b?c=1#d",
      "https://sub.domain.co.uk/path",
    ]) {
      expect(validateDestination(url).ok).toBe(true);
    }
  });

  it("refuses everything that would make /c/ an SSRF probe or an open redirect", () => {
    const rejected = [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1:8787/admin",
      "http://localhost:3000/api/leads",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://[::1]/",
      "http://[::ffff:7f00:1]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://metadata.google.internal/",
      "http://db.internal/",
      "http://x.local/",
      "ftp://example.com/file",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://user:pass@example.com/",
      "https://example.com/a b",
      "https://example.com/<script>",
      "",
      "   ",
      `https://example.com/${"y".repeat(2100)}`,
    ];
    for (const url of rejected) {
      expect(validateDestination(url).ok, url).toBe(false);
    }
  });

  it("keeps a public port that happens to be unusual", () => {
    expect(validateDestination("https://example.com:8443/proposal")).toMatchObject({ ok: true });
  });
});

describe("normalizeDestination", () => {
  it("treats a bare host and its trailing slash as one target", () => {
    expect(normalizeDestination("https://acme.com/")).toBe(normalizeDestination("https://acme.com"));
  });
});

describe("discoverLinks", () => {
  it("finds bare URLs in a plain-text body and labels them", () => {
    const found = discoverLinks({
      text: "See https://acme.com/portfolio and our rate card at https://acme.com/pricing.",
    });
    expect(found.map((l) => l.destinationUrl)).toEqual([
      "https://acme.com/portfolio",
      "https://acme.com/pricing",
    ]);
    expect(found[0]!.label).toBe("acme.com/portfolio");
  });

  it("does not swallow sentence punctuation into the link", () => {
    const found = discoverLinks({ text: "Reach us at https://acme.com/contact." });
    expect(found[0]!.destinationUrl).toBe("https://acme.com/contact");
  });

  it("deduplicates the same destination written twice", () => {
    const found = discoverLinks({
      text: "https://acme.com/ and also https://acme.com/ again",
    });
    expect(found).toHaveLength(1);
  });

  it("reads hrefs out of html, including entities", () => {
    const found = discoverLinks({
      html: '<a href="https://acme.com/a?x=1&amp;y=2">here</a>',
    });
    expect(found[0]!.destinationUrl).toBe("https://acme.com/a?x=1&y=2");
  });

  it("drops private, non-http and malformed destinations instead of minting a redirect", () => {
    const found = discoverLinks({
      text: "https://ok.example.com/ https://169.254.169.254/ http://localhost:3000/ javascript:alert(1)",
    });
    expect(found.map((l) => l.destinationUrl)).toEqual(["https://ok.example.com/"]);
  });

  it("caps the number of links per message", () => {
    const text = Array.from({ length: 30 }, (_u, i) => `https://a${i}.example.com/`).join(" ");
    expect(discoverLinks({ text })).toHaveLength(12);
    expect(discoverLinks({ text, max: 3 })).toHaveLength(3);
  });

  it("labels a www host without the prefix", () => {
    expect(labelFor("https://www.acme.com")).toBe("acme.com");
    expect(labelFor("not a url")).toBe("not a url");
  });
});

describe("buildTrackedHtml", () => {
  it("appends the pixel for a real send", () => {
    const built = buildTrackedHtml({
      html: textToHtml("Hi there"),
      token: TOKEN,
      domain: DOMAIN,
      links: [],
    });
    expect(built.html).toContain(`<img src="${DOMAIN}/o/${TOKEN}.gif"`);
    expect(built.pixelSrc).toBe(`${DOMAIN}/o/${TOKEN}.gif`);
    expect(built.html.indexOf("<img")).toBeGreaterThan(built.html.indexOf("Hi there"));
  });

  it("renders safe bold, bullet and inline-link formatting into email HTML", () => {
    const html = textToHtml("**Approach:**\n\n- Validate each event\n\nSee [Linear](https://linear.app) for the queue pattern.");
    expect(html).toContain("<strong>Approach:</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain('<a href="https://linear.app"');
    expect(html).not.toContain("**Approach:**");
  });

  it("escapes markup that is not part of the supported formatting", () => {
    const html = textToHtml("<img src=x onerror=alert(1)> **safe**");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("<strong>safe</strong>");
    expect(html).not.toContain("<img src=x");
  });

  it("rewrites a bare URL in the text to the click redirect", () => {
    const built = buildTrackedHtml({
      html: textToHtml("See https://acme.com/portfolio for work."),
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/portfolio")],
    });
    expect(built.html).toContain(`<a href="${DOMAIN}/c/LinkToken0123456789abcdefghijKl"`);
    expect(built.rewritten).toEqual(["https://acme.com/portfolio"]);
    expect(built.unused).toEqual([]);
  });

  it("rewrites an existing anchor href", () => {
    const built = buildTrackedHtml({
      html: '<p><a href="https://acme.com/portfolio">our work</a></p>',
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/portfolio")],
    });
    expect(built.html).toContain(`href="${DOMAIN}/c/LinkToken0123456789abcdefghijKl"`);
    expect(built.html).not.toMatch(/href="https:\/\/acme\.com/);
    // The link text a human wrote is untouched.
    expect(built.html).toContain(">our work</a>");
  });

  it("matches a destination written with or without a trailing slash", () => {
    const built = buildTrackedHtml({
      html: '<a href="https://acme.com">x</a>',
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/")],
    });
    expect(built.rewritten).toHaveLength(1);
  });

  it("reports links the body never mentions instead of failing silently", () => {
    const built = buildTrackedHtml({
      html: textToHtml("no links here"),
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/missing")],
    });
    expect(built.unused).toEqual(["https://acme.com/missing"]);
    expect(built.rewritten).toEqual([]);
  });

  it("matches the whole URL, not just its first character", () => {
    // A quantifier outside the capture group used to make this match "https://a".
    const built = buildTrackedHtml({
      html: "<p>See https://acme.com/deep/path?with=query&more=1 for work.</p>",
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/deep/path?with=query&more=1")],
    });
    expect(built.rewritten).toEqual(["https://acme.com/deep/path?with=query&more=1"]);
    expect(built.html).toContain(`href="${DOMAIN}/c/`);
    // The visible text still names the destination — that is honest — but no
    // href may point at it directly, or the click would never reach us.
    expect(built.html).not.toMatch(/href="https:\/\/acme\.example\.com/);
    expect(built.html).not.toMatch(/href="https:\/\/acme\.com/);
  });

  it("produces an inert preview: no pixel, no host to call", () => {
    const built = buildTrackedHtml({
      html: textToHtml("See https://acme.com/portfolio."),
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/portfolio")],
      preview: true,
    });
    expect(built.html).not.toContain("<img");
    expect(built.html).not.toContain(DOMAIN);
    expect(built.html).toContain(`href="#preview-LinkToken0123456789abcdefghijKl"`);
    expect(built.pixelSrc).toBeNull();
  });

  it("never touches markup when linkifying text", () => {
    const built = buildTrackedHtml({
      html: '<div style="background:url(https://cdn.example.com/bg.png)">https://acme.com/x</div>',
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/x")],
    });
    expect(built.html).toContain("url(https://cdn.example.com/bg.png)");
    expect(built.html).toContain(`<a href="${DOMAIN}/c/`);
  });

  it("leaves a style block alone", () => {
    const built = buildTrackedHtml({
      html: "<style>a{background:url(https://acme.com/x)}</style><p>https://acme.com/x</p>",
      token: TOKEN,
      domain: DOMAIN,
      links: [link("https://acme.com/x")],
    });
    expect(built.html).toContain("url(https://acme.com/x)");
    expect(built.html).toContain(`<a href="${DOMAIN}/c/`);
  });

  it("inserts the pixel before </body> when the template has one", () => {
    const built = buildTrackedHtml({
      html: "<html><body><p>hi</p></body></html>",
      token: TOKEN,
      domain: DOMAIN,
      links: [],
    });
    expect(built.html).toMatch(/<img src="[^"]*\.gif"[^>]*><\/body>/);
  });

  it("escapes the injected attributes", () => {
    const built = buildTrackedHtml({
      html: "<p>hi</p>",
      token: TOKEN,
      domain: 'https://evil.example.com/"><script>alert(1)</script>',
      links: [],
    });
    expect(built.html).not.toContain("<script>");
  });

  it("strips a pixel back out of a stored body", () => {
    const built = buildTrackedHtml({
      html: "<p>hi</p>",
      token: TOKEN,
      domain: DOMAIN,
      links: [],
    });
    expect(stripTrackingPixels(built.html)).toBe("<p>hi</p>");
    expect(stripTrackingPixels(`<img src='${DOMAIN}/o/${TOKEN}.gif' alt='x'><p>hi</p>`)).toBe("<p>hi</p>");
  });
});
