import { TZDate } from "@date-fns/tz";
import { addDays as addDaysFns, differenceInCalendarDays, format, parseISO } from "date-fns";

/**
 * Calendar-day helpers (BUSINESS_RULES §1).
 *
 * A "date string" is a calendar day like "2026-10-19". In the database these are `@db.Date` columns,
 * which Prisma reads and writes as `Date` objects at UTC midnight. Calendar days are always computed in
 * the **mess timezone**, never in server time.
 */
export type DateString = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isDateString = (value: string): value is DateString =>
  DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Today's calendar day in a timezone, e.g. `todayIn("Asia/Dhaka")`. */
export const todayIn = (timeZone: string, now: Date = new Date()): DateString =>
  format(new TZDate(now, timeZone), "yyyy-MM-dd");

/** Date string → value for a `@db.Date` column. */
export const toDbDate = (date: DateString): Date => {
  if (!isDateString(date)) throw new RangeError(`Invalid date string: ${date}`);
  return new Date(`${date}T00:00:00.000Z`);
};

/** `@db.Date` column value → date string. */
export const fromDbDate = (date: Date): DateString => date.toISOString().slice(0, 10);

export const addDays = (date: DateString, days: number): DateString =>
  format(addDaysFns(parseISO(date), days), "yyyy-MM-dd");

/** Number of calendar days from `from` to `to`, counting both ends (Oct 1 → Oct 3 = 3). */
export const daysInclusive = (from: DateString, to: DateString) =>
  differenceInCalendarDays(parseISO(to), parseISO(from)) + 1;

/**
 * The exact instant of a wall-clock time on a calendar day in a timezone.
 * e.g. `zonedDateTime("2026-10-19", "10:30", "Asia/Dhaka")` → 2026-10-19T04:30:00.000Z
 */
export function zonedDateTime(date: DateString, time: string, timeZone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  return new Date(new TZDate(year, month - 1, day, hours, minutes, timeZone).getTime());
}
