import { describe, expect, it } from "vitest";
import { buildThreadHeaders, normalizeMessageId } from "@/server/services/email-threading";

describe("follow-up threading", () => {
  it("accepts a real RFC Message-ID and trims it", () => {
    expect(normalizeMessageId("  <abc.123@mail.example.com> ")).toBe("<abc.123@mail.example.com>");
  });

  it("ignores opaque provider ids that are not header values", () => {
    expect(normalizeMessageId("re_abc123")).toBeNull();
    expect(normalizeMessageId("<broken>")).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
  });

  it("puts the chain oldest-first in References and the parent in In-Reply-To", () => {
    const headers = buildThreadHeaders(
      ["parent", "grandparent"],
      new Map([
        ["parent", "<second@example.com>"],
        ["grandparent", "<first@example.com>"],
      ]),
    );
    expect(headers).toEqual({
      "In-Reply-To": "<second@example.com>",
      References: "<first@example.com> <second@example.com>",
    });
  });

  it("does not pretend to thread when the parent id is unknown", () => {
    expect(buildThreadHeaders(["parent"], new Map([["parent", "re_123"]]))).toEqual({});
    expect(buildThreadHeaders([], new Map())).toEqual({});
  });
});
