import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEAD_DATE_RANGES, leadDateRange } from "@/lib/date-ranges";
import { paginationItems } from "@/lib/pagination";
import { activityTotals, bucketActivity } from "@/lib/activity";
import { listLeadsQuerySchema } from "@/lib/validation/outreach";

describe("lead list pagination", () => {
  it("shows every page when there are seven or fewer", () => {
    expect(paginationItems(1, 1)).toEqual([1]);
    expect(paginationItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("pins the first page to the left", () => {
    expect(paginationItems(1, 10)).toEqual([1, 2, 3, 4, 5, "ellipsis", 10]);
  });

  it("keeps one neighbour on each side in the middle", () => {
    expect(paginationItems(5, 10)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
  });

  it("pins the last page to the right", () => {
    expect(paginationItems(10, 10)).toEqual([1, "ellipsis", 6, 7, 8, 9, 10]);
  });

  it("clamps a page outside the range", () => {
    expect(paginationItems(99, 10)).toEqual([1, "ellipsis", 6, 7, 8, 9, 10]);
    expect(paginationItems(-2, 10)).toEqual([1, 2, 3, 4, 5, "ellipsis", 10]);
  });
});

describe("lead date presets", () => {
  // Wednesday 14 May 2025, local noon. Using local constructors keeps the
  // expectation valid in every developer timezone.
  const now = new Date(2025, 4, 14, 12, 0, 0);
  const localDay = (value: string) => {
    const date = new Date(value);
    return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  };

  it("offers the requested presets plus wider windows", () => {
    const values = LEAD_DATE_RANGES.map((range) => range.value);
    expect(values).toEqual(
      expect.arrayContaining([
        "today",
        "yesterday",
        "this_week",
        "last_week",
        "this_month",
        "last_month",
      ]),
    );
  });

  it("starts the week on Monday", () => {
    expect(localDay(leadDateRange("this_week", now)!.from)).toEqual([2025, 5, 12]);
    expect(localDay(leadDateRange("this_week", now)!.to)).toEqual([2025, 5, 14]);
  });

  it("covers Monday through Sunday for last week", () => {
    expect(localDay(leadDateRange("last_week", now)!.from)).toEqual([2025, 5, 5]);
    expect(localDay(leadDateRange("last_week", now)!.to)).toEqual([2025, 5, 11]);
  });

  it("handles the previous month and quarter", () => {
    expect(localDay(leadDateRange("last_month", now)!.from)).toEqual([2025, 4, 1]);
    expect(localDay(leadDateRange("last_month", now)!.to)).toEqual([2025, 4, 30]);
    expect(localDay(leadDateRange("last_quarter", now)!.from)).toEqual([2025, 1, 1]);
    expect(localDay(leadDateRange("last_quarter", now)!.to)).toEqual([2025, 3, 31]);
  });

  it("uses a local midnight, not UTC midnight", () => {
    const today = leadDateRange("today", now)!;
    const from = new Date(today.from);
    expect([from.getHours(), from.getMinutes(), from.getSeconds()]).toEqual([0, 0, 0]);
  });
});

describe("activity buckets", () => {
  const now = new Date("2025-05-14T12:00:00.000Z");
  const daily = [
    { date: "2025-05-08", leads: 2, sent: 4, opens: 3, clicks: 1 },
    { date: "2025-05-12", leads: 1, sent: 2, opens: 2, clicks: 0 },
    { date: "2025-05-14", leads: 3, sent: 1, opens: 1, clicks: 2 },
    { date: "2025-04-30", leads: 9, sent: 9, opens: 9, clicks: 9 },
  ];

  it("makes seven daily buckets ending today", () => {
    const buckets = bucketActivity(daily, "day", now);
    expect(buckets).toHaveLength(7);
    expect(buckets.at(-1)!.key).toBe("2025-05-14");
    expect(activityTotals(buckets)).toEqual({ leads: 6, sent: 7, opens: 6, clicks: 3 });
  });

  it("makes twelve rolling weekly buckets", () => {
    const buckets = bucketActivity(daily, "week", now);
    expect(buckets).toHaveLength(12);
    expect(buckets.at(-1)!.from).toBe("2025-05-08");
    expect(buckets.at(-1)!.to).toBe("2025-05-14");
    expect(buckets.at(0)!.from).toBe("2025-02-20");
    expect(activityTotals(buckets)).toEqual({ leads: 15, sent: 16, opens: 15, clicks: 12 });
  });

  it("makes twelve calendar-month buckets", () => {
    const buckets = bucketActivity(daily, "month", now);
    expect(buckets).toHaveLength(12);
    expect(buckets.at(-1)!.key).toBe("2025-05");
    expect(buckets.find((bucket) => bucket.key === "2025-04")!.leads).toBe(9);
    expect(activityTotals(buckets)).toEqual({ leads: 15, sent: 16, opens: 15, clicks: 12 });
  });
});

describe("lead list filters", () => {
  it("defaults to newest created first", () => {
    expect(listLeadsQuerySchema.parse({})).toMatchObject({
      sort: "created_at",
      order: "desc",
      page: 1,
      pageSize: 25,
    });
  });

  it("accepts every pipeline state", () => {
    for (const pipeline of ["sent", "both", "doc", "draft"] as const) {
      expect(listLeadsQuerySchema.parse({ pipeline }).pipeline).toBe(pipeline);
    }
  });

  it("rejects an unknown pipeline and a backwards date range", () => {
    expect(() => listLeadsQuerySchema.parse({ pipeline: "maybe" })).toThrow();
    expect(() =>
      listLeadsQuerySchema.parse({ from: "2025-05-10T00:00:00Z", to: "2025-05-01T00:00:00Z" }),
    ).toThrow(/from must be before to/);
  });
});

describe("0007 migration", () => {
  it("defines the counted view the list filters on", () => {
    const sql = readFileSync("supabase/migrations/0007_lead_list_view.sql", "utf8");
    expect(sql).toContain("create or replace view public.lead_list");
    expect(sql).toContain("proposal_count");
    expect(sql).toContain("draft_count");
    expect(sql).toContain("leads_created_at_idx");
    expect(sql).toContain("grant select on public.lead_list to service_role");
  });
});
