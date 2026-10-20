import { ApprovalStatus, MonthStatus, PaidFrom, SettlementDirection } from "@prisma/client";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createSlots, createUser } from "../../test/factories.js";
import { addDays, toDbDate } from "../../utils/date.js";

const preview = (messId: string, monthId: string, user: Parameters<typeof authHeader>[0]) =>
  request(app).get(`/api/v1/messes/${messId}/months/${monthId}/preview`).set(authHeader(user));

/** `count` days of one meal from Oct 1, for a member. */
async function meals(
  messId: string,
  monthId: string,
  memberId: string,
  slotId: string,
  count: number,
  extra: { guestQuantity?: number } = {},
) {
  await prisma.mealEntry.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      messId,
      monthId,
      memberId,
      slotId,
      date: toDbDate(addDays("2026-10-01", i)),
      quantity: 1,
      ...extra,
    })),
  });
}

describe("GET /months/:monthId/preview", () => {
  it("prices meals, credits deposits and own-pocket bazar, and carries over last month's balance", async () => {
    const aUser = await createUser({ name: "Anis" });
    const { mess, ownerMember: a, month } = await createMess(aUser);
    const bUser = await createUser({ name: "Bashir" });
    const cUser = await createUser({ name: "Chayan" });
    const b = await addMember(mess.id, bUser);
    const c = await addMember(mess.id, cUser, { joinedAt: "2026-10-15" });
    const { breakfast, lunch } = await createSlots(mess.id);

    // Weighted meals: Anis 10, Bashir 10 + 4 × ½ = 12, Chayan 5 lunches + 1 guest = 6. Total 28.
    await meals(mess.id, month.id, a.id, lunch.id, 10);
    await meals(mess.id, month.id, b.id, lunch.id, 10);
    await meals(mess.id, month.id, b.id, breakfast.id, 4);
    await meals(mess.id, month.id, c.id, lunch.id, 5);
    await prisma.mealEntry.updateMany({
      where: { memberId: c.id, date: toDbDate("2026-10-01") },
      data: { guestQuantity: 1 },
    });

    const bazar = (shopperId: string, totalAmount: number, paidFrom: PaidFrom, status: ApprovalStatus) =>
      prisma.bazar.create({
        data: {
          messId: mess.id,
          monthId: month.id,
          shopperId,
          date: toDbDate("2026-10-05"),
          totalAmount,
          paidFrom,
          status,
          createdById: aUser.id,
        },
      });
    await bazar(a.id, 1000, PaidFrom.MESS_FUND, ApprovalStatus.APPROVED);
    await bazar(b.id, 400, PaidFrom.OWN_POCKET, ApprovalStatus.APPROVED);
    await bazar(c.id, 99, PaidFrom.MESS_FUND, ApprovalStatus.PENDING);

    const deposit = (memberId: string, amount: number, status: ApprovalStatus) =>
      prisma.deposit.create({ data: { messId: mess.id, monthId: month.id, memberId, amount, status } });
    await deposit(b.id, 500, ApprovalStatus.APPROVED);
    await deposit(c.id, 300, ApprovalStatus.APPROVED);
    await deposit(c.id, 50, ApprovalStatus.PENDING);

    // September was closed with Bashir owing 100, of which he has paid 60; the mess kept 1000 cash.
    const september = await prisma.messMonth.create({
      data: {
        messId: mess.id,
        year: 2026,
        month: 9,
        startDate: toDbDate("2026-09-01"),
        endDate: toDbDate("2026-09-30"),
        status: MonthStatus.CLOSED,
        closingCash: 1000,
      },
    });
    const summary = await prisma.memberMonthSummary.create({
      data: {
        monthId: september.id,
        memberId: b.id,
        totalMeals: 0,
        mealCost: 0,
        sharedCost: 0,
        chargeTotal: 0,
        totalDeposit: 0,
        openingBalance: 0,
        closingBalance: -100,
      },
    });
    await prisma.settlementPayment.create({
      data: {
        messId: mess.id,
        monthId: september.id,
        summaryId: summary.id,
        memberId: b.id,
        direction: SettlementDirection.MEMBER_TO_MESS,
        amount: 60,
        recordedById: a.id,
      },
    });

    const res = await preview(mess.id, month.id, cUser);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isFinal: false,
      previousMonthClosed: true,
      totals: { totalBazar: "1400.00", totalMeals: "28", mealRate: "50.0000", totalDeposits: "800.00" },
      pending: { bazars: { count: 1, total: "99.00" }, deposits: { count: 1, total: "50.00" } },
      cash: {
        openingCash: "1000.00",
        deposits: "800.00",
        messFundBazar: "1000.00",
        closingCash: "800.00",
      },
    });
    const byName = Object.fromEntries(
      res.body.data.members.map((m: { member: { name: string } }) => [m.member.name, m]),
    );
    expect(byName.Anis).toMatchObject({ weightedMeals: "10", mealCost: "500.00", closingBalance: "-500.00" });
    expect(byName.Bashir).toMatchObject({
      weightedMeals: "12",
      mealCost: "600.00",
      deposits: "500.00",
      ownPocketBazar: "400.00",
      totalDeposit: "900.00",
      openingBalance: "-40.00",
      closingBalance: "260.00",
    });
    expect(byName.Chayan).toMatchObject({
      weightedMeals: "6",
      mealCost: "300.00",
      closingBalance: "0.00",
      member: { isYou: true },
    });
  });

  it("splits meal costs to the paisa, and shares the bazar equally when nobody ate", async () => {
    const aUser = await createUser({ name: "A" });
    const { mess, ownerMember: a, month } = await createMess(aUser);
    const b = await addMember(mess.id, await createUser({ name: "B" }));
    const c = await addMember(mess.id, await createUser({ name: "C" }));
    await prisma.bazar.create({
      data: {
        messId: mess.id,
        monthId: month.id,
        shopperId: a.id,
        date: toDbDate("2026-10-05"),
        totalAmount: 1000,
        status: ApprovalStatus.APPROVED,
        createdById: aUser.id,
      },
    });

    const noMeals = await preview(mess.id, month.id, aUser);
    expect(noMeals.body.data.totals).toMatchObject({ mealRate: "0.0000", totalMeals: "0" });
    const shared = noMeals.body.data.members.map((m: { sharedCost: string }) => m.sharedCost).sort();
    expect(shared).toEqual(["333.33", "333.33", "333.34"]);

    const { lunch } = await createSlots(mess.id);
    for (const m of [a, b, c]) await meals(mess.id, month.id, m.id, lunch.id, 1);
    const withMeals = await preview(mess.id, month.id, aUser);
    expect(withMeals.body.data.totals.mealRate).toBe("333.3333");
    const costs = withMeals.body.data.members.map((m: { mealCost: string }) => m.mealCost);
    expect([...costs].sort()).toEqual(["333.33", "333.33", "333.34"]);
    expect(withMeals.body.data.members.every((m: { sharedCost: string }) => m.sharedCost === "0.00")).toBe(
      true,
    );
  });

  it("doesn't carry balances over from a month that isn't closed yet, and stays inside the mess", async () => {
    const aUser = await createUser();
    const { mess, month } = await createMess(aUser);
    await prisma.messMonth.create({
      data: {
        messId: mess.id,
        year: 2026,
        month: 9,
        startDate: toDbDate("2026-09-01"),
        endDate: toDbDate("2026-09-30"),
        closingCash: 999,
      },
    });
    const res = await preview(mess.id, month.id, aUser);
    expect(res.body.data).toMatchObject({ previousMonthClosed: false, cash: { openingCash: "0.00" } });

    // Someone in another mess can't read this month through their own mess.
    const otherOwner = await createUser();
    const other = await createMess(otherOwner);
    expect((await preview(other.mess.id, month.id, otherOwner)).status).toBe(404);
  });
});
