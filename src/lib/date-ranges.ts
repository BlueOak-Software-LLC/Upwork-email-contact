/**
 * Local-calendar date presets for the lead list.
 *
 * The boundaries are computed in the browser's timezone and sent as ISO
 * instants, so "today" means the reader's today. A server that computed
 * midnight in UTC would put evening leads in the wrong day for most of the
 * world.
 */

export const LEAD_DATE_RANGES = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "this_week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "this_quarter", label: "This quarter" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "this_year", label: "This year" },
] as const;

export type LeadDateRangeKey = (typeof LEAD_DATE_RANGES)[number]["value"];

export interface DateRange {
  from: string;
  to: string;
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

const endOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

/** Monday as the first day of the week. */
const startOfWeek = (date: Date) => {
  const start = startOfDay(date);
  const offset = (start.getDay() + 6) % 7;
  return addDays(start, -offset);
};

const startOfMonth = (date: Date) => new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
const endOfMonth = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

/** Calendar quarter: Jan-Mar is 1, Apr-Jun is 2, and so on. */
const startOfQuarter = (date: Date) =>
  new Date(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1, 0, 0, 0, 0);

const endOfQuarter = (date: Date) => {
  const start = startOfQuarter(date);
  return new Date(start.getFullYear(), start.getMonth() + 3, 0, 23, 59, 59, 999);
};

export function leadDateRange(
  key: LeadDateRangeKey,
  now: Date = new Date(),
): DateRange | null {
  switch (key) {
    case "today":
      return { from: startOfDay(now).toISOString(), to: endOfDay(now).toISOString() };
    case "yesterday": {
      const yesterday = addDays(now, -1);
      return {
        from: startOfDay(yesterday).toISOString(),
        to: endOfDay(yesterday).toISOString(),
      };
    }
    case "this_week":
      return { from: startOfWeek(now).toISOString(), to: endOfDay(now).toISOString() };
    case "last_week": {
      const thisWeek = startOfWeek(now);
      return {
        from: addDays(thisWeek, -7).toISOString(),
        to: endOfDay(addDays(thisWeek, -1)).toISOString(),
      };
    }
    case "this_month":
      return { from: startOfMonth(now).toISOString(), to: endOfDay(now).toISOString() };
    case "last_month": {
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);
      return {
        from: startOfMonth(lastMonth).toISOString(),
        to: endOfMonth(lastMonth).toISOString(),
      };
    }
    case "last_7_days":
      return { from: startOfDay(addDays(now, -6)).toISOString(), to: endOfDay(now).toISOString() };
    case "last_30_days":
      return { from: startOfDay(addDays(now, -29)).toISOString(), to: endOfDay(now).toISOString() };
    case "this_quarter":
      return { from: startOfQuarter(now).toISOString(), to: endOfDay(now).toISOString() };
    case "last_quarter": {
      const lastQuarterEnd = new Date(
        startOfQuarter(now).getFullYear(),
        startOfQuarter(now).getMonth(),
        0,
        23,
        59,
        59,
        999,
      );
      return {
        from: startOfQuarter(lastQuarterEnd).toISOString(),
        to: endOfQuarter(lastQuarterEnd).toISOString(),
      };
    }
    case "this_year":
      return {
        from: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0).toISOString(),
        to: endOfDay(now).toISOString(),
      };
  }
}

export function leadDateRangeLabel(key: string | null | undefined): string | null {
  return LEAD_DATE_RANGES.find((range) => range.value === key)?.label ?? null;
}
