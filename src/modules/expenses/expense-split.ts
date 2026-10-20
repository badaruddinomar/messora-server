import type { SplitType } from "@prisma/client";
import type { Decimal, DecimalInput } from "../../utils/money.js";
import type { MonthBasis } from "../months/month-basis.js";
import { expenseShares } from "../settlement/engine.js";

/** Each member's share of a shared expense in a month (BUSINESS_RULES §7); see `expenseShares`. */
export const splitExpense = (
  amount: DecimalInput,
  splitType: SplitType,
  basis: Pick<MonthBasis, "memberIds" | "meals">,
  customShares: { memberId: string; amount: DecimalInput }[] = [],
): Map<string, Decimal> =>
  expenseShares({ amount, splitType, shares: customShares }, basis.memberIds, basis.meals);
