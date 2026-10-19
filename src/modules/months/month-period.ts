import { addDays, type DateString } from "../../utils/date.js";

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
