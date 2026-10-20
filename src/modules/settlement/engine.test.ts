import { ChargeType, PaidFrom, SettlementDirection, SplitType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { toDbDate } from "../../utils/date.js";
import { Decimal, sumMoney } from "../../utils/money.js";
import { carriedBalance, computeMonth, expenseShares, weighted, type EngineInput } from "./engine.js";

const october = { startDate: toDbDate("2026-10-01"), endDate: toDbDate("2026-10-31") };
const since = (date: string, left?: string) => ({
  joinedAt: toDbDate(date),
  leftAt: left ? toDbDate(left) : null,
});

/** One meal entry worth `weightedMeals` (quantity 1 × weight), for building totals quickly. */
const meal = (memberId: string, weightedMeals: number) => ({
  memberId,
  quantity: 1,
  guestQuantity: 0,
  weight: weightedMeals,
});

const base = (overrides: Partial<EngineInput>): EngineInput => ({
  month: october,
  members: [],
  meals: [],
  bazars: [],
  deposits: [],
  expenses: [],
  charges: [],
  openingBalances: new Map(),
  openingCash: 0,
  settlements: [],
  prorateSeatRent: true,
  includeSeatRent: true,
  ...overrides,
});

const money = (d: Decimal) => d.toFixed(2);
const byMember = (bill: ReturnType<typeof computeMonth>) =>
  Object.fromEntries(
    bill.rows.map((r) => [
      r.memberId,
      {
        meals: r.weightedMeals.toString(),
        mealCost: money(r.mealCost),
        sharedCost: money(r.sharedCost),
        chargeTotal: money(r.chargeTotal),
        totalDeposit: money(r.totalDeposit),
        openingBalance: money(r.openingBalance),
        closingBalance: money(r.closingBalance),
      },
    ]),
  );

describe("paper fixture 1: an ordinary month for four members", () => {
  // Worked out by hand, the way a manager would on paper:
  // meal rate = 10,000 bazar / 200 meals = 50. Electricity 1,200 equally (300 each), cook 6,000 by
  // meals, Wi-Fi 1,000 equally paid by Chayan. Seats: Anis 3,000, Bashir 3,000, Chayan 2,500 from
  // the 16th (16/31 → 1,290.32), Dipu none. Bashir carries −200 from September.
  const bill = computeMonth(
    base({
      members: [
        { id: "a", ...since("2026-01-01"), seatRent: 3000 },
        { id: "b", ...since("2026-01-01"), seatRent: 3000 },
        { id: "c", ...since("2026-10-16"), seatRent: 2500 },
        { id: "d", ...since("2026-01-01"), seatRent: null },
      ],
      meals: [meal("a", 60), meal("b", 55), meal("c", 45), meal("d", 40)],
      bazars: [
        { shopperId: "a", amount: 8000, paidFrom: PaidFrom.MESS_FUND },
        { shopperId: "b", amount: 2000, paidFrom: PaidFrom.OWN_POCKET },
      ],
      deposits: [
        { memberId: "a", amount: 9000 },
        { memberId: "b", amount: 5000 },
        { memberId: "c", amount: 6000 },
        { memberId: "d", amount: 4000 },
      ],
      expenses: [
        {
          amount: 1200,
          splitType: SplitType.EQUAL,
          paidFrom: PaidFrom.MESS_FUND,
          paidByMemberId: null,
          shares: [],
        },
        {
          amount: 6000,
          splitType: SplitType.BY_MEAL,
          paidFrom: PaidFrom.MESS_FUND,
          paidByMemberId: null,
          shares: [],
        },
        {
          amount: 1000,
          splitType: SplitType.EQUAL,
          paidFrom: PaidFrom.OWN_POCKET,
          paidByMemberId: "c",
          shares: [],
        },
      ],
      charges: [
        { memberId: "d", type: ChargeType.FINE, amount: 50 },
        { memberId: "b", type: ChargeType.ADJUSTMENT, amount: -100 },
      ],
      openingBalances: new Map([["b", new Decimal(-200)]]),
      openingCash: 1500,
      settlements: [{ direction: SettlementDirection.MEMBER_TO_MESS, amount: 200 }],
    }),
  );

  it("prices meals at the meal rate", () => {
    expect(bill.totalBazar.toFixed(2)).toBe("10000.00");
    expect(bill.totalMeals.toString()).toBe("200");
    expect(bill.mealRate.toFixed(4)).toBe("50.0000");
    expect(bill.totalExpenses.toFixed(2)).toBe("8200.00");
  });

  it("gives every member the bill worked out by hand", () => {
    expect(byMember(bill)).toEqual({
      a: {
        meals: "60",
        mealCost: "3000.00",
        sharedCost: "2350.00",
        chargeTotal: "3000.00",
        totalDeposit: "9000.00",
        openingBalance: "0.00",
        closingBalance: "650.00",
      },
      b: {
        meals: "55",
        mealCost: "2750.00",
        sharedCost: "2200.00",
        chargeTotal: "2900.00",
        totalDeposit: "7000.00",
        openingBalance: "-200.00",
        closingBalance: "-1050.00",
      },
      c: {
        meals: "45",
        mealCost: "2250.00",
        sharedCost: "1900.00",
        chargeTotal: "1290.32",
        totalDeposit: "7000.00",
        openingBalance: "0.00",
        closingBalance: "1559.68",
      },
      d: {
        meals: "40",
        mealCost: "2000.00",
        sharedCost: "1750.00",
        chargeTotal: "50.00",
        totalDeposit: "4000.00",
        openingBalance: "0.00",
        closingBalance: "200.00",
      },
    });
    expect(bill.seatRentPeriods.get("c")).toMatchObject({ periodFrom: "2026-10-16", isProrated: true });
  });

  it("balances: the closing balances equal what came in minus every cost", () => {
    const totalCosts = sumMoney(bill.rows.map((r) => r.mealCost.plus(r.sharedCost).plus(r.chargeTotal)));
    const totalIn = sumMoney(bill.rows.map((r) => r.totalDeposit.plus(r.openingBalance)));
    expect(money(sumMoney(bill.rows.map((r) => r.closingBalance)))).toBe(money(totalIn.minus(totalCosts)));
    expect(money(sumMoney(bill.rows.map((r) => r.mealCost)))).toBe(money(bill.totalBazar));
  });

  it("works out the cash in hand (§9)", () => {
    expect(Object.fromEntries(Object.entries(bill.cash).map(([k, v]) => [k, money(v)]))).toEqual({
      openingCash: "1500.00",
      deposits: "24000.00",
      settlementsIn: "200.00",
      messFundBazar: "8000.00",
      messFundExpenses: "7200.00",
      settlementsOut: "0.00",
      closingCash: "10500.00",
    });
  });
});

describe("paper fixture 2: three members, awkward numbers", () => {
  const members = ["m1", "m2", "m3"].map((id) => ({ id, ...since("2026-01-01"), seatRent: null }));

  it("splits meal costs to the paisa; the leftover paisa goes to the lower id", () => {
    const bill = computeMonth(
      base({
        members,
        meals: [meal("m1", 1), meal("m2", 1), meal("m3", 1)],
        bazars: [{ shopperId: "m1", amount: 1000, paidFrom: PaidFrom.MESS_FUND }],
      }),
    );
    expect(bill.mealRate.toFixed(4)).toBe("333.3333");
    expect(bill.rows.map((r) => money(r.mealCost))).toEqual(["333.34", "333.33", "333.33"]);
  });

  it("shares the bazar equally when nobody ate, and BY_MEAL expenses too (§5, §7)", () => {
    const bill = computeMonth(
      base({
        members,
        bazars: [{ shopperId: "m2", amount: 1000, paidFrom: PaidFrom.MESS_FUND }],
        expenses: [
          {
            amount: 100,
            splitType: SplitType.BY_MEAL,
            paidFrom: PaidFrom.MESS_FUND,
            paidByMemberId: null,
            shares: [],
          },
        ],
      }),
    );
    expect(bill.mealRate.toFixed(4)).toBe("0.0000");
    expect(bill.rows.map((r) => money(r.mealCost))).toEqual(["0.00", "0.00", "0.00"]);
    expect(bill.rows.map((r) => money(r.sharedCost))).toEqual(["366.68", "366.66", "366.66"]);
  });

  it("charges a member who left with only an adjustment, and nothing for no data", () => {
    const bill = computeMonth(
      base({ members: [], charges: [{ memberId: "gone", type: ChargeType.ADJUSTMENT, amount: -50 }] }),
    );
    expect(bill.rows).toHaveLength(1);
    expect(money(bill.rows[0].closingBalance)).toBe("50.00");
    expect(money(bill.cash.closingCash)).toBe("0.00");
    expect(computeMonth(base({})).rows).toEqual([]);
  });
});

describe("paper fixture 3: joining, leaving and seat rent", () => {
  it("prorates seat rent for a mid-month join and leave, and skips seats already charged", () => {
    const bill = computeMonth(
      base({
        members: [
          { id: "joiner", ...since("2026-10-22"), seatRent: 3100 },
          { id: "leaver", ...since("2026-01-01", "2026-10-10"), seatRent: 3100 },
          { id: "charged", ...since("2026-01-01", "2026-10-10"), seatRent: 3100 },
        ],
        charges: [{ memberId: "charged", type: ChargeType.SEAT_RENT, amount: 1000 }],
      }),
    );
    const rent = Object.fromEntries(
      bill.rows.map((r) => [r.memberId, [money(r.seatRent), money(r.chargeTotal)]]),
    );
    expect(rent).toEqual({
      joiner: ["1000.00", "1000.00"],
      leaver: ["1000.00", "1000.00"],
      charged: ["0.00", "1000.00"],
    });
  });

  it("charges the full rent with proration off, and none when seat rent is excluded", () => {
    const members = [{ id: "joiner", ...since("2026-10-22"), seatRent: 3100 }];
    expect(money(computeMonth(base({ members, prorateSeatRent: false })).rows[0].chargeTotal)).toBe(
      "3100.00",
    );
    expect(money(computeMonth(base({ members, includeSeatRent: false })).rows[0].chargeTotal)).toBe("0.00");
  });

  it("counts meals and shares for someone with meals who isn't listed as taking part", () => {
    const bill = computeMonth(
      base({
        members: [{ id: "a", ...since("2026-01-01"), seatRent: null }],
        meals: [meal("a", 2), meal("z", 2)],
        bazars: [{ shopperId: "a", amount: 400, paidFrom: PaidFrom.MESS_FUND }],
      }),
    );
    expect(bill.rows.map((r) => [r.memberId, money(r.mealCost)])).toEqual([
      ["a", "200.00"],
      ["z", "200.00"],
    ]);
  });
});

describe("building blocks", () => {
  it("weights meals, including guests", () => {
    expect(weighted({ quantity: 1, guestQuantity: 2, weight: 0.5 }).toString()).toBe("1.5");
  });

  it("splits custom shares as entered", () => {
    const shares = expenseShares(
      {
        amount: 300,
        splitType: SplitType.CUSTOM,
        shares: [
          { memberId: "a", amount: 250 },
          { memberId: "b", amount: 50 },
        ],
      },
      ["a", "b", "c"],
      new Map(),
    );
    expect([...shares.entries()].map(([k, v]) => [k, money(v)])).toEqual([
      ["a", "250.00"],
      ["b", "50.00"],
    ]);
  });

  it("splits by meals, treating members missing from the meal counts as 0", () => {
    const shares = expenseShares(
      { amount: 90, splitType: SplitType.BY_MEAL, shares: [] },
      ["a", "b"],
      new Map([["a", new Decimal(3)]]),
    );
    expect([...shares.values()].map(money)).toEqual(["90.00", "0.00"]);
  });

  it("carries a balance forward after settlements both ways (§8)", () => {
    expect(
      money(carriedBalance(-500, [{ direction: SettlementDirection.MEMBER_TO_MESS, amount: 300 }])),
    ).toBe("-200.00");
    expect(money(carriedBalance(400, [{ direction: SettlementDirection.MESS_TO_MEMBER, amount: 400 }]))).toBe(
      "0.00",
    );
    expect(money(carriedBalance(-75.5, []))).toBe("-75.50");
  });

  it("subtracts refunds paid out from the cash in hand", () => {
    const bill = computeMonth(
      base({
        openingCash: 1000,
        settlements: [{ direction: SettlementDirection.MESS_TO_MEMBER, amount: 250 }],
      }),
    );
    expect(money(bill.cash.closingCash)).toBe("750.00");
  });
});
