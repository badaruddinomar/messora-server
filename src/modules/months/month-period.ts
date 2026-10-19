import { addDays, daysInclusive, type DateString } from "../../utils/date.js";

export const MIN_MONTH_START_DAY = 1;
/** Capped at 28 so every month has the start day (BUSINESS_RULES §3). */
export const MAX_MONTH_START_DAY = 28;

export interface MonthPeriod {
  /** The month is labelled by the calendar month it starts in. */
  year: number;
  month: number; // 1-12
  startDate: DateString;
  endDate: DateString;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The billing month labelled (year, month) for a mess whose months start on `startDay`. */
export function periodFor(year: number, month: number, startDay: number): MonthPeriod {
  if (startDay < MIN_MONTH_START_DAY || startDay > MAX_MONTH_START_DAY) {
    throw new RangeError(`Month start day must be between 1 and 28, got ${startDay}`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    year,
    month,
    startDate: `${year}-${pad(month)}-${pad(startDay)}`,
    endDate: addDays(`${nextYear}-${pad(nextMonth)}-${pad(startDay)}`, -1),
  };
}

/** The billing month that contains `date`. e.g. start day 5: Nov 3 belongs to "October" (Oct 5 – Nov 4). */
export function periodContaining(date: DateString, startDay: number): MonthPeriod {
  const [year, month, day] = date.split("-").map(Number);
  if (day >= startDay) return periodFor(year, month, startDay);
  return month === 1 ? periodFor(year - 1, 12, startDay) : periodFor(year, month - 1, startDay);
}

/** The billing month after `period`. */
export const nextPeriod = ({ year, month }: MonthPeriod, startDay: number) =>
  month === 12 ? periodFor(year + 1, 1, startDay) : periodFor(year, month + 1, startDay);

/** A billing month is never shorter than this, even right after the start day changes. */
const MIN_MONTH_DAYS = 14;

/**
 * The billing month that follows one ending on `previousEnd` (BUSINESS_RULES §3).
 *
 * It always starts the day after `previousEnd`, so months never overlap or leave gaps. Normally it ends
 * the day before `startDay` in the next calendar month. If the start day was changed, the first month
 * after the change runs until the next `startDay` that falls in a later calendar month and at least
 * 14 days ahead, so it's never a stub. Months are labelled by the calendar month they start in.
 */
export function periodAfter(previousEnd: DateString, startDay: number): MonthPeriod {
  if (startDay < MIN_MONTH_START_DAY || startDay > MAX_MONTH_START_DAY) {
    throw new RangeError(`Month start day must be between 1 and 28, got ${startDay}`);
  }
  const start = addDays(previousEnd, 1);
  const [year, month] = start.split("-").map(Number);

  // Walk forward month by month to the first suitable next start date.
  let y = year;
  let m = month;
  let nextStart: DateString;
  do {
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
    nextStart = `${y}-${pad(m)}-${pad(startDay)}`;
  } while (daysInclusive(start, nextStart) - 1 < MIN_MONTH_DAYS);

  return { year, month, startDate: start, endDate: addDays(nextStart, -1) };
}
