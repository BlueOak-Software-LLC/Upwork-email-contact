/**
 * Daily leads / sends / opens / clicks rolled up into the three Overview
 * windows. All dates are UTC day keys, matching `leadsRepo.metrics()` and
 * `trackingRepo.stats()`; the labels are for humans.
 */

export const ACTIVITY_PERIODS = {
  day: { label: "Daily", windowLabel: "Last 7 days", days: 7 },
  week: { label: "Weekly", windowLabel: "Last 12 weeks", days: 84 },
  month: { label: "Monthly", windowLabel: "Last 12 months", days: 365 },
} as const;

export type ActivityPeriod = keyof typeof ACTIVITY_PERIODS;

export function parseActivityPeriod(value: string | null | undefined): ActivityPeriod {
  return value === "week" || value === "month" ? value : "day";
}

export interface DailyActivity {
  date: string;
  leads: number;
  sent: number;
  opens: number;
  clicks: number;
}

export interface ActivityBucket {
  key: string;
  label: string;
  fullLabel: string;
  from: string;
  to: string;
  leads: number;
  sent: number;
  opens: number;
  clicks: number;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const utcDay = (date: Date) => date.toISOString().slice(0, 10);
const utcDayStart = (date: Date) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const addUtcDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

function monthStart(year: number, month: number) {
  return new Date(Date.UTC(year, month, 1));
}

function monthEnd(year: number, month: number) {
  return new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999));
}

function shortDate(date: Date) {
  return MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
}

function fullDate(date: Date) {
  return FULL_MONTHS[date.getUTCMonth()] + " " + date.getUTCDate();
}

export function bucketActivity(
  daily: DailyActivity[],
  period: ActivityPeriod,
  now: Date = new Date(),
): ActivityBucket[] {
  const today = utcDayStart(now);
  const buckets: ActivityBucket[] = [];

  if (period === "day") {
    for (let index = 6; index >= 0; index -= 1) {
      const day = addUtcDays(today, -index);
      const key = utcDay(day);
      buckets.push({
        key,
        label: shortDate(day),
        fullLabel: fullDate(day),
        from: key,
        to: key,
        leads: 0,
        sent: 0,
        opens: 0,
        clicks: 0,
      });
    }
  } else if (period === "week") {
    // Twelve rolling seven-day blocks ending today. Aligning the last block to
    // today keeps the final bar complete instead of a three-day stub.
    for (let index = 11; index >= 0; index -= 1) {
      const end = addUtcDays(today, -index * 7);
      const start = addUtcDays(end, -6);
      buckets.push({
        key: utcDay(start),
        label: shortDate(start),
        fullLabel: shortDate(start) + " - " + shortDate(end),
        from: utcDay(start),
        to: utcDay(end),
        leads: 0,
        sent: 0,
        opens: 0,
        clicks: 0,
      });
    }
  } else {
    for (let index = 11; index >= 0; index -= 1) {
      const start = monthStart(today.getUTCFullYear(), today.getUTCMonth() - index);
      const end = monthEnd(start.getUTCFullYear(), start.getUTCMonth());
      buckets.push({
        key: utcDay(start).slice(0, 7),
        label: MONTHS[start.getUTCMonth()] ?? "",
        fullLabel: FULL_MONTHS[start.getUTCMonth()] + " " + start.getUTCFullYear(),
        from: utcDay(start),
        to: utcDay(end),
        leads: 0,
        sent: 0,
        opens: 0,
        clicks: 0,
      });
    }
  }

  if (period === "month") {
    const byMonth = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    for (const point of daily) {
      const bucket = byMonth.get(point.date.slice(0, 7));
      if (bucket) addPoint(bucket, point);
    }
  } else if (period === "week") {
    for (const point of daily) {
      const bucket = buckets.find(
        (candidate) => point.date >= candidate.from && point.date <= candidate.to,
      );
      if (bucket) addPoint(bucket, point);
    }
  } else {
    const byDay = new Map(buckets.map((bucket) => [bucket.key, bucket]));
    for (const point of daily) {
      const bucket = byDay.get(point.date.slice(0, 10));
      if (bucket) addPoint(bucket, point);
    }
  }

  return buckets;
}

function addPoint(bucket: ActivityBucket, point: DailyActivity) {
  bucket.leads += point.leads;
  bucket.sent += point.sent;
  bucket.opens += point.opens;
  bucket.clicks += point.clicks;
}

export function activityTotals(buckets: ActivityBucket[]) {
  return buckets.reduce(
    (totals, bucket) => ({
      leads: totals.leads + bucket.leads,
      sent: totals.sent + bucket.sent,
      opens: totals.opens + bucket.opens,
      clicks: totals.clicks + bucket.clicks,
    }),
    { leads: 0, sent: 0, opens: 0, clicks: 0 },
  );
}
