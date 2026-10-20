import type { MessMonth } from "@prisma/client";
import { daysInclusive, fromDbDate, type DateString } from "../../utils/date.js";
import { Decimal, roundMoney, type DecimalInput } from "../../utils/money.js";

/**
 * A member's seat rent for a month (BUSINESS_RULES §6): the full rent, or with `prorateSeatRent` on and
 * a mid-month join or leave, `rent × daysPresent / daysInMonth`. Null if they weren't in the mess
 * during the month.
 */
export function seatRent(
  rent: DecimalInput,
  member: { joinedAt: Date | null; leftAt: Date | null },
  month: Pick<MessMonth, "startDate" | "endDate">,
  prorate: boolean,
) {
  if (!member.joinedAt) return null;
  const monthStart = fromDbDate(month.startDate);
  const monthEnd = fromDbDate(month.endDate);
  const joined = fromDbDate(member.joinedAt);
  const left = member.leftAt ? fromDbDate(member.leftAt) : null;
  const from: DateString = joined > monthStart ? joined : monthStart;
  const to: DateString = left && left < monthEnd ? left : monthEnd;
  if (from > to) return null;

  const daysPresent = daysInclusive(from, to);
  const daysInMonth = daysInclusive(monthStart, monthEnd);
  const isProrated = prorate && daysPresent < daysInMonth;
  const amount = isProrated
    ? roundMoney(new Decimal(rent).times(daysPresent).dividedBy(daysInMonth))
    : roundMoney(rent);
  return { amount, periodFrom: from, periodTo: to, isProrated, daysPresent, daysInMonth };
}
