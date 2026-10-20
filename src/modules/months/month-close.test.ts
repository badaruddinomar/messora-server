import { ApprovalStatus, MessRole, MonthStatus } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createSlots, createUser } from "../../test/factories.js";
import { addDays, toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-11-05T08:00:00Z"); // October has ended
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * October for two members: 10 lunches each (meal rate 1000 / 20 = 50), a 600 electricity bill
 * split equally, deposits of 1200 and 700, and a 1500 seat for Anis.
 */
async function october() {
  const aUser = await createUser({ name: "Anis" });
  const { mess, ownerMember: a, month } = await createMess(aUser);
  await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: false } });
  const bUser = await createUser({ name: "Bashir" });
  const b = await addMember(mess.id, bUser);
  const { lunch } = await createSlots(mess.id);
  for (const m of [a, b]) {
    await prisma.mealEntry.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        messId: mess.id,
        monthId: month.id,
        memberId: m.id,
        slotId: lunch.id,
        date: toDbDate(addDays("2026-10-01", i)),
        quantity: 1,
      })),
    });
  }
  await prisma.bazar.create({
    data: {
      messId: mess.id,
      monthId: month.id,
      shopperId: a.id,
      date: toDbDate("2026-10-03"),
      totalAmount: 1000,
      status: ApprovalStatus.APPROVED,
      createdById: aUser.id,
    },
  });
  await prisma.sharedExpense.create({
    data: {
      messId: mess.id,
      monthId: month.id,
      category: "ELECTRICITY",
      title: "Electricity",
      amount: 600,
      billDate: toDbDate("2026-10-20"),
      createdById: aUser.id,
    },
  });
  for (const [m, amount] of [
    [a, 1200],
    [b, 700],
  ] as const) {
    await prisma.deposit.create({
      data: { messId: mess.id, monthId: month.id, memberId: m.id, amount, status: ApprovalStatus.APPROVED },
    });
  }
  const room = await prisma.room.create({ data: { messId: mess.id, name: "R1" } });
  const seat = await prisma.seat.create({
    data: { messId: mess.id, roomId: room.id, label: "A", monthlyRent: 1500 },
  });
  await prisma.messMember.update({ where: { id: a.id }, data: { seatId: seat.id } });
  return { aUser, bUser, a, b, mess, month };
}

const startClosing = (messId: string, monthId: string, user: Parameters<typeof authHeader>[0]) =>
  request(app)
    .post(`${base(messId)}/months/${monthId}/start-closing`)
    .set(authHeader(user));
const close = (messId: string, monthId: string, user: Parameters<typeof authHeader>[0], version: number) =>
  request(app)
    .post(`${base(messId)}/months/${monthId}/close`)
    .set(authHeader(user))
    .send({ version });

describe("closing a month", () => {
  it("locks the month, writes everyone's bill, charges seat rent and carries balances into November", async () => {
    const { aUser, bUser, a, b, mess, month } = await october();

    const check = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/close-check`)
      .set(authHeader(aUser));
    expect(check.body.data).toMatchObject({
      ended: true,
      earlierOpen: [],
      pending: { bazars: 0, deposits: 0 },
      canStartClosing: true,
      canClose: false,
    });

    const closing = await startClosing(mess.id, month.id, aUser);
    expect(closing.body.data).toMatchObject({ status: "CLOSING", version: 1 });

    // Nothing in October can change now.
    const late = await request(app)
      .post(`${base(mess.id)}/deposits`)
      .set(authHeader(bUser))
      .send({ date: "2026-10-30", amount: 100 });
    expect(late.body.code).toBe("MONTH_CLOSED");

    const closed = await close(mess.id, month.id, aUser, 1);
    expect(closed.status).toBe(200);
    expect(closed.body.data).toMatchObject({ status: "CLOSED", version: 2 });

    // Anis: meals 500 + electricity 300 + seat 1500 = 2300 vs 1200 paid → owes 1100.
    // Bashir: 500 + 300 = 800 vs 700 → owes 100.
    const summaries = await prisma.memberMonthSummary.findMany({ where: { monthId: month.id } });
    const byMember = Object.fromEntries(summaries.map((s) => [s.memberId, s]));
    expect(byMember[a.id]).toMatchObject({ isSettled: false });
    expect(byMember[a.id].closingBalance.toFixed(2)).toBe("-1100.00");
    expect(byMember[a.id].chargeTotal.toFixed(2)).toBe("1500.00");
    expect(byMember[b.id].closingBalance.toFixed(2)).toBe("-100.00");

    const stored = await prisma.messMonth.findUniqueOrThrow({ where: { id: month.id } });
    expect(stored).toMatchObject({ status: MonthStatus.CLOSED, closedById: aUser.id });
    expect(stored.mealRate!.toFixed(4)).toBe("50.0000");
    expect(stored.closingCash!.toFixed(2)).toBe("300.00"); // 1900 deposits − 1000 bazar − 600 bill
    expect(
      await prisma.memberCharge.count({ where: { monthId: month.id, type: "SEAT_RENT", memberId: a.id } }),
    ).toBe(1);

    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: bUser.id, type: "MONTH_CLOSED" },
    });
    expect(note).toMatchObject({
      title: "October 2026 is closed",
      body: "Meal rate ৳50.00. You owe the mess ৳100.00.",
    });

    // A closed month is never recalculated: even if old records change, its bill stays.
    await prisma.deposit.updateMany({ where: { monthId: month.id, memberId: b.id }, data: { amount: 9999 } });
    const final = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/preview`)
      .set(authHeader(bUser));
    expect(final.body.data).toMatchObject({
      isFinal: true,
      totals: { mealRate: "50.0000", totalBazar: "1000.00" },
      cash: { closingCash: "300.00" },
    });
    const bRow = final.body.data.members.find((m: { member: { id: string } }) => m.member.id === b.id);
    expect(bRow).toMatchObject({ closingBalance: "-100.00", totalDeposit: "700.00", isSettled: false });

    // November starts from October's balances and cash.
    const november = await prisma.messMonth.findFirstOrThrow({ where: { messId: mess.id, month: 11 } });
    const nov = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/preview`)
      .set(authHeader(aUser));
    const aNov = nov.body.data.members.find((m: { member: { id: string } }) => m.member.id === a.id);
    expect(aNov.openingBalance).toBe("-1100.00");
    expect(nov.body.data.cash.openingCash).toBe("300.00");
  });

  it("refuses to close too early, out of order, with things waiting, or on stale numbers", async () => {
    const { aUser, b, mess, month } = await october();

    setNow("2026-10-20T08:00:00Z");
    expect((await startClosing(mess.id, month.id, aUser)).body.code).toBe("MONTH_NOT_ENDED");
    setNow("2026-11-05T08:00:00Z");

    const pending = await prisma.deposit.create({
      data: { messId: mess.id, monthId: month.id, memberId: b.id, amount: 50 },
    });
    expect((await startClosing(mess.id, month.id, aUser)).body.code).toBe("PENDING_ENTRIES");
    await prisma.deposit.delete({ where: { id: pending.id } });

    await prisma.messMonth.create({
      data: {
        messId: mess.id,
        year: 2026,
        month: 9,
        startDate: toDbDate("2026-09-01"),
        endDate: toDbDate("2026-09-30"),
      },
    });
    expect((await startClosing(mess.id, month.id, aUser)).body.code).toBe("MONTHS_OUT_OF_ORDER");
    await prisma.messMonth.updateMany({
      where: { messId: mess.id, month: 9 },
      data: { status: MonthStatus.CLOSED },
    });

    await startClosing(mess.id, month.id, aUser);
    const stale = await close(mess.id, month.id, aUser, 0);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("VERSION_CONFLICT");
    expect(await prisma.memberMonthSummary.count({ where: { monthId: month.id } })).toBe(0);
  });

  it("lets only admins reopen a closing month, and never a closed one", async () => {
    const { aUser, bUser, b, mess, month } = await october();
    await prisma.messMember.update({ where: { id: b.id }, data: { role: MessRole.MANAGER } });
    await startClosing(mess.id, month.id, aUser);

    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/months/${month.id}/reopen`)
          .set(authHeader(bUser))
      ).status,
    ).toBe(403);
    const reopened = await request(app)
      .post(`${base(mess.id)}/months/${month.id}/reopen`)
      .set(authHeader(aUser));
    expect(reopened.body.data).toMatchObject({ status: "OPEN", version: 2 });

    // A manager can close it after starting again.
    await startClosing(mess.id, month.id, bUser);
    expect((await close(mess.id, month.id, bUser, 3)).status).toBe(200);
    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/months/${month.id}/reopen`)
          .set(authHeader(aUser))
      ).status,
    ).toBe(409);
    expect((await close(mess.id, month.id, aUser, 4)).status).toBe(409);
  });

  it("is for managers; the month manager can close their own month", async () => {
    const { bUser, b, mess, month } = await october();
    expect((await startClosing(mess.id, month.id, bUser)).status).toBe(403);
    await prisma.messMonth.update({ where: { id: month.id }, data: { managerId: b.id } });
    expect((await startClosing(mess.id, month.id, bUser)).status).toBe(200);
    expect((await close(mess.id, month.id, bUser, 1)).status).toBe(200);
  });
});

describe("member statement", () => {
  it("explains a member's bill line by line; members only see their own", async () => {
    const { aUser, bUser, a, mess, month } = await october();
    const res = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/statement/me`)
      .set(authHeader(aUser));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isFinal: false,
      mealRate: "50.0000",
      totals: {
        weightedMeals: "10",
        mealCost: "500.00",
        sharedCost: "300.00",
        chargeTotal: "1500.00",
        totalDeposit: "1200.00",
        closingBalance: "-1100.00",
      },
      meals: [{ slot: "Lunch", meals: "10", weight: "1", weightedMeals: "10" }],
      expenses: [{ title: "Electricity", amount: "600.00", share: "300.00" }],
      bazarShare: null,
      charges: [{ type: "SEAT_RENT", amount: "1500.00", isEstimate: true }],
      deposits: [{ amount: "1200.00" }],
      settlement: null,
    });

    expect(
      (
        await request(app)
          .get(`${base(mess.id)}/months/${month.id}/statement/${a.id}`)
          .set(authHeader(bUser))
      ).status,
    ).toBe(404);

    await startClosing(mess.id, month.id, aUser);
    await close(mess.id, month.id, aUser, 1);
    const final = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/statement/${a.id}`)
      .set(authHeader(aUser));
    expect(final.body.data).toMatchObject({
      isFinal: true,
      totals: { closingBalance: "-1100.00" },
      charges: [{ type: "SEAT_RENT", amount: "1500.00", isEstimate: false }],
      settlement: { settledAmount: "0.00", isSettled: false, payments: [] },
    });
  });
});
