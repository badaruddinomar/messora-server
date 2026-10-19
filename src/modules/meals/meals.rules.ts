import { Prisma } from "@prisma/client";
import { zonedDateTime, type DateString } from "../../utils/date.js";

/**
 * When members stop being able to change their own meal for a slot (BUSINESS_RULES §4): the slot's
 * cutoff time on the meal's date, in the mess timezone. A slot without a cutoff locks when the day
 * starts, so it has to be set the day before.
 */
export const cutoffAt = (date: DateString, cutoffTime: string | null, timeZone: string) =>
  zonedDateTime(date, cutoffTime ?? "00:00", timeZone);

export const isPastCutoff = (
  date: DateString,
  cutoffTime: string | null,
  timeZone: string,
  now = new Date(),
) => now >= cutoffAt(date, cutoffTime, timeZone);

/** Weighted meals of one entry: (own + guest meals) × slot weight (BUSINESS_RULES §4). */
export const weightedMeals = (
  entry: { quantity: Prisma.Decimal.Value; guestQuantity: Prisma.Decimal.Value },
  weight: Prisma.Decimal.Value,
) => new Prisma.Decimal(entry.quantity).plus(entry.guestQuantity).times(weight);

/** Whether a member belongs to the mess on a given day (joined on or before it, not left before it). */
export function wasMemberOn(member: { joinedAt: Date | null; leftAt: Date | null }, date: Date) {
  if (!member.joinedAt || member.joinedAt > date) return false;
  return !member.leftAt || member.leftAt >= date;
}
