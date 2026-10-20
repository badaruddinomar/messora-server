/**
 * The bill engine (BUSINESS_RULES §5–§9): pure functions over plain data, no database. The month
 * preview and month closing both run it, so what members see during the month is computed exactly
 * like the final bill.
 */
import { ChargeType, PaidFrom, SettlementDirection, SplitType } from "@prisma/client";
import { Decimal, splitByWeight, splitEqually, sumMoney, type DecimalInput } from "../../utils/money.js";
import { seatRent } from "../rooms/seat-rent.js";

export interface EngineMember {
  id: string;
  joinedAt: Date | null;
  leftAt: Date | null;
  /** Monthly rent of the seat they hold, if any. */
  seatRent: DecimalInput | null;
}

export interface EngineInput {
  month: { startDate: Date; endDate: Date };
  /** Everyone who was in the mess on at least one day of the month (§7 "takes part"). */
  members: EngineMember[];
  meals: { memberId: string; quantity: DecimalInput; guestQuantity: DecimalInput; weight: DecimalInput }[];
  /** APPROVED bazars only. */
  bazars: { shopperId: string; amount: DecimalInput; paidFrom: PaidFrom }[];
  /** APPROVED deposits only. */
  deposits: { memberId: string; amount: DecimalInput }[];
  /** APPROVED shared expenses; `shares` only for CUSTOM. */
  expenses: {
    amount: DecimalInput;
    splitType: SplitType;
    paidFrom: PaidFrom;
    paidByMemberId: string | null;
    shares: { memberId: string; amount: DecimalInput }[];
  }[];
  charges: { memberId: string; type: ChargeType; amount: DecimalInput }[];
  /** Each member's balance carried from the previous closed month (see `carriedBalance`). */
  openingBalances: Map<string, Decimal>;
  openingCash: DecimalInput;
  /** Settlement payments recorded in this month (they move cash, §9). */
  settlements: { direction: SettlementDirection; amount: DecimalInput }[];
  prorateSeatRent: boolean;
  /**
   * Add seat rent for members who hold a seat and have no SEAT_RENT charge yet: an estimate during
   * the month, and the amounts closing writes as charges.
   */
  includeSeatRent: boolean;
}

const zero = () => new Decimal(0);
const add = (map: Map<string, Decimal>, key: string, amount: DecimalInput) =>
  map.set(key, (map.get(key) ?? zero()).plus(amount));

/** Weighted meals of one entry: (own + guest meals) × slot weight (§4). */
export const weighted = (e: { quantity: DecimalInput; guestQuantity: DecimalInput; weight: DecimalInput }) =>
  new Decimal(e.quantity).plus(e.guestQuantity).times(e.weight);

/**
 * Each member's share of a shared expense (§7): EQUAL between everyone who took part, BY_MEAL by
 * weighted meals (EQUAL if nobody ate), CUSTOM as entered. Shares always add up to the amount.
 * `memberIds` must be sorted (the largest-remainder tie-break goes to the lower id).
 */
export function expenseShares(
  expense: {
    amount: DecimalInput;
    splitType: SplitType;
    shares: { memberId: string; amount: DecimalInput }[];
  },
  memberIds: string[],
  meals: Map<string, Decimal>,
): Map<string, Decimal> {
  if (expense.splitType === SplitType.CUSTOM) {
    return new Map(expense.shares.map((s) => [s.memberId, new Decimal(s.amount)]));
  }
  const totalMeals = sumMoney(memberIds.map((id) => meals.get(id) ?? 0));
  if (expense.splitType === SplitType.BY_MEAL && !totalMeals.isZero()) {
    return splitByWeight(
      expense.amount,
      memberIds.map((id) => ({ key: id, weight: meals.get(id) ?? 0 })),
    );
  }
  return splitEqually(expense.amount, memberIds);
}

/** A closed month's balance after the settlements made against it (§8). */
export function carriedBalance(
  closingBalance: DecimalInput,
  settlements: { direction: SettlementDirection; amount: DecimalInput }[],
) {
  return sumMoney([
    closingBalance,
    ...settlements.map((s) =>
      s.direction === SettlementDirection.MEMBER_TO_MESS
        ? new Decimal(s.amount)
        : new Decimal(s.amount).negated(),
    ),
  ]);
}

export function computeMonth(input: EngineInput) {
  const participantIds = input.members.map((m) => m.id);
  // Stable order for the largest-remainder tie-break (§7: lower memberId first).
  const memberIds = [
    ...new Set([
      ...participantIds,
      ...input.meals.map((e) => e.memberId),
      ...input.charges.map((c) => c.memberId),
    ]),
  ].sort();
  const splitIds = [...new Set([...participantIds, ...input.meals.map((e) => e.memberId)])].sort();

  const meals = new Map(memberIds.map((id) => [id, zero()]));
  for (const e of input.meals) add(meals, e.memberId, weighted(e));
  const totalMeals = sumMoney(meals.values());

  // §5 meal rate. With no meals at all, the bazar can't be priced per meal, so it's shared equally.
  const totalBazar = sumMoney(input.bazars.map((b) => b.amount));
  const mealRate = totalMeals.isZero() ? zero() : totalBazar.dividedBy(totalMeals).toDecimalPlaces(4);
  const mealCosts = totalMeals.isZero()
    ? new Map<string, Decimal>()
    : splitByWeight(
        totalBazar,
        splitIds.map((id) => ({ key: id, weight: meals.get(id)! })),
      );
  const sharedCosts = new Map<string, Decimal>();
  if (totalMeals.isZero())
    for (const [id, share] of splitEqually(totalBazar, splitIds)) add(sharedCosts, id, share);

  // §7 shared expenses.
  for (const expense of input.expenses) {
    for (const [id, share] of expenseShares(expense, splitIds, meals)) add(sharedCosts, id, share);
  }

  // §6 charges, plus seat rent for seats not charged yet.
  const charges = new Map<string, Decimal>();
  for (const c of input.charges) add(charges, c.memberId, c.amount);
  const seatRents = new Map<string, Decimal>();
  const seatRentPeriods = new Map<string, NonNullable<ReturnType<typeof seatRent>>>();
  if (input.includeSeatRent) {
    for (const m of input.members) {
      const charged = input.charges.some((c) => c.memberId === m.id && c.type === ChargeType.SEAT_RENT);
      const rent =
        m.seatRent !== null && !charged ? seatRent(m.seatRent, m, input.month, input.prorateSeatRent) : null;
      if (rent) {
        seatRents.set(m.id, rent.amount);
        seatRentPeriods.set(m.id, rent);
      }
    }
  }

  // §8 member balances.
  const rows = memberIds.map((memberId) => {
    const deposits = sumMoney(input.deposits.filter((d) => d.memberId === memberId).map((d) => d.amount));
    const ownPocketBazar = sumMoney(
      input.bazars
        .filter((b) => b.shopperId === memberId && b.paidFrom === PaidFrom.OWN_POCKET)
        .map((b) => b.amount),
    );
    const ownPocketExpenses = sumMoney(
      input.expenses
        .filter((e) => e.paidByMemberId === memberId && e.paidFrom === PaidFrom.OWN_POCKET)
        .map((e) => e.amount),
    );
    const mealCost = mealCosts.get(memberId) ?? zero();
    const sharedCost = sharedCosts.get(memberId) ?? zero();
    const seatRentAmount = seatRents.get(memberId) ?? zero();
    const chargeTotal = (charges.get(memberId) ?? zero()).plus(seatRentAmount);
    const totalDeposit = deposits.plus(ownPocketBazar).plus(ownPocketExpenses);
    const openingBalance = input.openingBalances.get(memberId) ?? zero();
    return {
      memberId,
      weightedMeals: meals.get(memberId)!,
      mealCost,
      sharedCost,
      chargeTotal,
      /** Seat rent counted in chargeTotal that isn't a charge yet. */
      seatRent: seatRentAmount,
      deposits,
      ownPocketBazar,
      ownPocketExpenses,
      totalDeposit,
      openingBalance,
      closingBalance: openingBalance.plus(totalDeposit).minus(mealCost.plus(sharedCost).plus(chargeTotal)),
    };
  });

  // §9 cash in hand.
  const totalDeposits = sumMoney(input.deposits.map((d) => d.amount));
  const sumWhere = <T extends { amount: DecimalInput }>(rows: T[], match: (r: T) => boolean) =>
    sumMoney(rows.filter(match).map((r) => r.amount));
  const messFundBazar = sumWhere(input.bazars, (b) => b.paidFrom === PaidFrom.MESS_FUND);
  const messFundExpenses = sumWhere(input.expenses, (e) => e.paidFrom === PaidFrom.MESS_FUND);
  const settlementsIn = sumWhere(
    input.settlements,
    (s) => s.direction === SettlementDirection.MEMBER_TO_MESS,
  );
  const settlementsOut = sumWhere(
    input.settlements,
    (s) => s.direction === SettlementDirection.MESS_TO_MEMBER,
  );
  const openingCash = new Decimal(input.openingCash);

  return {
    totalBazar,
    totalMeals,
    mealRate,
    totalDeposits,
    totalExpenses: sumMoney(input.expenses.map((e) => e.amount)),
    cash: {
      openingCash,
      deposits: totalDeposits,
      settlementsIn,
      messFundBazar,
      messFundExpenses,
      settlementsOut,
      closingCash: openingCash
        .plus(totalDeposits)
        .plus(settlementsIn)
        .minus(messFundBazar)
        .minus(messFundExpenses)
        .minus(settlementsOut),
    },
    rows,
    seatRentPeriods,
  };
}

export type MonthBill = ReturnType<typeof computeMonth>;
