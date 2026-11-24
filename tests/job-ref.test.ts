import { describe, expect, it } from "vitest";
import {
  jobIdCandidates,
  jobIdFromUrl,
  jobUrlCandidates,
  normalizeJobId,
  normalizeJobUrl,
} from "@/lib/job-ref";

/**
 * The identity of a job, as two scrapers will actually write it.
 *
 * Every case here came from the failure the user reported: the same Upwork post
 * arriving twice — once with `job_id`, once with only a link — and being filed
 * as two leads. Upwork makes that easy to do, because its link embeds the id
 * behind a `~02` prefix and adds a tracking query that differs per viewer.
 */

describe("normalizeJobUrl", () => {
  it("drops the tracking noise that differs between two scrapes", () => {
    const a = "https://www.upwork.com/jobs/~021234567890abcdef?src=saved&tracking=xyz";
    const b = "https://UPWORK.com/jobs/~021234567890abcdef/";
    expect(normalizeJobUrl(a)).toBe(normalizeJobUrl(b));
    expect(normalizeJobUrl(a)).toBe("https://upwork.com/jobs/~021234567890abcdef");
  });

  it("keeps a query that carries the job itself", () => {
    expect(normalizeJobUrl("https://boards.example.com/role?job_id=4412&utm_source=x")).toBe(
      "https://boards.example.com/role?job_id=4412",
    );
  });

  it("sorts kept parameters so order cannot create a second identity", () => {
    expect(normalizeJobUrl("https://x.example/j?a=1&job_id=9")).toBe(
      normalizeJobUrl("https://x.example/j?job_id=9&a=1"),
    );
  });

  it("accepts the shapes a payload actually contains", () => {
    expect(normalizeJobUrl("upwork.com/jobs/~02ABC")).toBe("https://upwork.com/jobs/~02ABC");
    expect(normalizeJobUrl("  https://x.example/j#comments  ")).toBe("https://x.example/j");
    expect(normalizeJobUrl("https://x.example/j/")).toBe("https://x.example/j");
  });

  it("returns empty for anything that is not a link", () => {
    for (const value of ["", null, undefined, "not a url", "javascript:alert(1)", "ftp://x/y"]) {
      expect(normalizeJobUrl(value as string | null | undefined)).toBe("");
    }
  });
});

describe("normalizeJobId", () => {
  it("strips Upwork's link prefix so the id and the link agree", () => {
    expect(normalizeJobId("~021234567890abcdef")).toBe("1234567890abcdef");
    expect(normalizeJobId("021234567890abcdef")).toBe("1234567890abcdef");
    expect(normalizeJobId(" 1234567890ABCDEF ")).toBe("1234567890abcdef");
  });

  it("leaves an ordinary id alone", () => {
    expect(normalizeJobId("4412")).toBe("4412");
    expect(normalizeJobId("job-77")).toBe("job-77");
    expect(normalizeJobId(null)).toBe("");
    expect(normalizeJobId(987654)).toBe("987654");
  });
});

describe("jobIdFromUrl", () => {
  it("reads the id out of an Upwork job link", () => {
    expect(jobIdFromUrl("https://www.upwork.com/jobs/~021234567890abcdef?src=share")).toBe(
      "1234567890abcdef",
    );
  });

  it("reads the id out of numeric board links and query ids", () => {
    expect(jobIdFromUrl("https://boards.example.com/job/12345678")).toBe("12345678");
    expect(jobIdFromUrl("https://boards.example.com/role?job_id=99887")).toBe("99887");
    expect(jobIdFromUrl("https://boards.example.com/role?id=42")).toBe("42");
  });

  it("finds nothing in a slug-only link, which is honest", () => {
    expect(jobIdFromUrl("https://www.upwork.com/finding/jobs/need-a-3d-artist")).toBeNull();
    expect(jobIdFromUrl("https://x.example/jobs/abc")).toBeNull();
    expect(jobIdFromUrl("")).toBeNull();
  });
});

describe("candidates for lookup", () => {
  it("offers the canonical link and the raw text, deduped", () => {
    const raw = "https://www.upwork.com/jobs/~02ABC?src=saved";
    const list = jobUrlCandidates(raw);
    expect(list[0]).toBe("https://upwork.com/jobs/~02ABC");
    expect(list).toContain(raw);
    expect(new Set(list).size).toBe(list.length);
  });

  it("already-canonical input yields exactly one candidate", () => {
    expect(jobUrlCandidates("https://upwork.com/jobs/~02ABC")).toEqual([
      "https://upwork.com/jobs/~02ABC",
    ]);
  });

  it("matches a stored id against the id implied by an incoming link", () => {
    // The whole point: payload A carried job_id, payload B carries only the link.
    expect(
      jobIdCandidates({ jobId: null, jobUrl: "https://www.upwork.com/jobs/~021234567890abcdef" }),
    ).toEqual(["1234567890abcdef"]);
    expect(
      jobIdCandidates({ jobId: "1234567890ABCDEF", jobUrl: "https://www.upwork.com/jobs/~021234567" }),
    ).toEqual(["1234567890abcdef", "1234567"]);
  });

  it("returns nothing when neither field identifies a job", () => {
    expect(jobIdCandidates({ jobId: null, jobUrl: null })).toEqual([]);
    expect(jobIdCandidates({ jobId: "", jobUrl: "   " })).toEqual([]);
  });
});
