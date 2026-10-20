import { SplitType } from "@prisma/client";
import { Decimal, splitByWeight, splitEqually, type DecimalInput } from "../../utils/money.js";
import type { MonthBasis } from "../months/month-basis.js";

/**
 * Each member's share of a shared expense (BUSINESS_RULES §7):
 * - EQUAL between everyone who took part in the month;
 * - BY_MEAL in proportion to weighted meals (EQUAL if nobody ate);
 * - CUSTOM as entered (already checked to add up to the amount).
 * Shares always add up to the amount exactly (largest remainder).
 */
export function splitExpense(
  amount: DecimalInput,
  splitType: SplitType,
  basis: Pick<MonthBasis, "memberIds" | "meals" | "totalMeals">,
  customShares: { memberId: string; amount: DecimalInput }[] = [],
): Map<string, Decimal> {
  if (splitType === SplitType.CUSTOM) {
    return new Map(customShares.map((s) => [s.memberId, new Decimal(s.amount)]));
  }
  if (splitType === SplitType.BY_MEAL && !basis.totalMeals.isZero()) {
    return splitByWeight(
      amount,
      basis.memberIds.map((id) => ({ key: id, weight: basis.meals.get(id) ?? 0 })),
    );
  }
  return splitEqually(amount, basis.memberIds);
}
