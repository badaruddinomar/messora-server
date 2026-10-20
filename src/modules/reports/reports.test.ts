import { ApprovalStatus, MemberStatus } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-05T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * October closed with Anis +700, Bashir −500, Chhoton 0 and ৳200 in hand (as in settlement.test).
 * November so far, with no meals: 300 of bazar and a 900 electricity bill, shared equally, so 400
 * each. Waiting: a 50 bazar, a join request and a meal request; Bashir shops on the 7th.
 */
async function messInNovember() {
  const aUser = await createUser({ name: "Anis" });
  const { mess, ownerMember: a, month: october } = await createMess(aUser);
  await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: false } });
  const bUser = await createUser({ name: "Bashir" });
  const cUser = await createUser({ name: "Chhoton" });
  const b = await addMember(mess.id, bUser);
  const c = await addMember(mess.id, cUser);
  await addMember(mess.id, await createUser({ name: "Dipu" }), { status: MemberStatus.PENDING });

  const bazar = (
    monthId: string,
    date: string,
    totalAmount: number,
    status: ApprovalStatus = ApprovalStatus.APPROVED,
  ) =>
    prisma.bazar.create({
      data: {
        messId: mess.id,
        monthId,
        shopperId: a.id,
        date: toDbDate(date),
        totalAmount,
        status,
        createdById: aUser.id,
      },
    });
  await bazar(october.id, "2026-10-03", 1500);
  for (const [m, amount] of [
    [a, 1200],
    [c, 500],
  ] as const) {
    await prisma.deposit.create({
      data: { messId: mess.id, monthId: october.id, memberId: m.id, amount, status: ApprovalStatus.APPROVED },
    });
  }
  await request(app)
    .post(`${base(mess.id)}/months/${october.id}/start-closing`)
    .set(authHeader(aUser));
  await request(app)
    .post(`${base(mess.id)}/months/${october.id}/close`)
    .set(authHeader(aUser))
    .send({ version: 1 });

  const november = await prisma.messMonth.findFirstOrThrow({ where: { messId: mess.id, month: 11 } });
  await bazar(november.id, "2026-11-02", 300);
  await bazar(november.id, "2026-11-04", 50, ApprovalStatus.PENDING);
  await prisma.sharedExpense.create({
    data: {
      messId: mess.id,
      monthId: november.id,
      category: "ELECTRICITY",
      title: "October bill",
      amount: 900,
      billDate: toDbDate("2026-11-03"),
      createdById: aUser.id,
    },
  });
  await prisma.mealRequest.create({
    data: { messId: mess.id, memberId: b.id, date: toDbDate("2026-11-06"), request: "Less oil" },
  });
  await prisma.bazarSchedule.create({
    data: { messId: mess.id, monthId: november.id, memberId: b.id, date: toDbDate("2026-11-07") },
  });
  return { aUser, bUser, a, b, c, mess, october, november };
}

describe("dashboard", () => {
  it("gives managers cash in hand, what's waiting, who owes what and last month's dues", async () => {
    const { aUser, mess } = await messInNovember();
    const res = await request(app)
      .get(`${base(mess.id)}/dashboard`)
      .set(authHeader(aUser));
    expect(res.status).toBe(200);
    expect(res.body.data.you).toMatchObject({ closingBalance: "300.00", nextDuty: null });
    expect(res.body.data.manager).toMatchObject({
      cashInHand: "-1000.00",
      pending: {
        bazars: { count: 1, total: "50.00" },
        deposits: { count: 0 },
        joinRequests: 1,
        mealRequests: 1,
      },
      dueSoFar: "1300.00",
      creditSoFar: "300.00",
      lastClosed: {
        month: 10,
        dueToMess: "500.00",
        owedToMembers: "700.00",
        unsettled: 2,
        collectable: true,
      },
    });
    expect(
      res.body.data.manager.balances.map((r: { member: { name: string }; balance: string }) => [
        r.member.name,
        r.balance,
      ]),
    ).toEqual([
      ["Bashir", "-900.00"],
      ["Chhoton", "-400.00"],
      ["Anis", "300.00"],
    ]);
  });

  it("gives members only their own numbers", async () => {
    const { bUser, mess } = await messInNovember();
    const res = await request(app)
      .get(`${base(mess.id)}/dashboard`)
      .set(authHeader(bUser));
    expect(res.body.data.manager).toBeNull();
    expect(res.body.data.you).toMatchObject({ closingBalance: "-900.00", nextDuty: "2026-11-07" });
    expect(res.body.data.month).toMatchObject({ month: 11, isCurrent: true });
  });
});

describe("reports", () => {
  it("shows the trend: closed months as written, the current one so far", async () => {
    const { bUser, mess } = await messInNovember();
    const res = await request(app)
      .get(`${base(mess.id)}/reports/trends?months=6`)
      .set(authHeader(bUser));
    expect(res.body.data).toEqual([
      expect.objectContaining({ month: 10, isFinal: true, totalBazar: "1500.00", totalDeposits: "1700.00" }),
      expect.objectContaining({ month: 11, isFinal: false, totalBazar: "300.00", totalExpenses: "900.00" }),
    ]);
    const bad = await request(app)
      .get(`${base(mess.id)}/reports/trends?months=100`)
      .set(authHeader(bUser));
    expect(bad.status).toBe(400);
  });

  it("breaks a month down by category and by day", async () => {
    const { bUser, mess, november } = await messInNovember();
    const res = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/report`)
      .set(authHeader(bUser));
    expect(res.body.data.expensesByCategory).toEqual([
      { category: "ELECTRICITY", total: "900.00", count: 1 },
    ]);
    // Every day up to today, with only approved bazar counted.
    expect(res.body.data.bazarByDay).toEqual([
      { date: "2026-11-01", total: "0.00", count: 0 },
      { date: "2026-11-02", total: "300.00", count: 1 },
      { date: "2026-11-03", total: "0.00", count: 0 },
      { date: "2026-11-04", total: "0.00", count: 0 },
      { date: "2026-11-05", total: "0.00", count: 0 },
    ]);
  });

  it("is only for the mess's own members", async () => {
    const { mess } = await messInNovember();
    const outsider = await createUser();
    const res = await request(app)
      .get(`${base(mess.id)}/dashboard`)
      .set(authHeader(outsider));
    expect(res.status).toBe(404);
  });
});

describe("CSV exports", () => {
  it("exports the month summary and the bazar list as downloadable CSV", async () => {
    const { bUser, mess, october, november } = await messInNovember();
    const summary = await request(app)
      .get(`${base(mess.id)}/months/${october.id}/export/summary`)
      .set(authHeader(bUser));
    expect(summary.status).toBe(200);
    expect(summary.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(summary.headers["content-disposition"]).toBe(
      `attachment; filename="${mess.slug}-2026-10-summary.csv"`,
    );
    const lines = summary.text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe(
      "Member,Meals,Meal cost,Shared cost,Charges,Deposits,Paid themselves,Carried in,Balance,Status",
    );
    expect(lines.slice(1, 4)).toEqual([
      "Anis,0,0.00,500.00,0.00,1200.00,0.00,0.00,700.00,Refund",
      "Bashir,0,0.00,500.00,0.00,0.00,0.00,0.00,-500.00,Due",
      "Chhoton,0,0.00,500.00,0.00,500.00,0.00,0.00,0.00,Settled",
    ]);
    expect(summary.text).toContain("Closed October 2026");

    const bazars = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/export/bazars`)
      .set(authHeader(bUser));
    expect(bazars.text.replace(/^\uFEFF/, "").split("\r\n").slice(0, 3)).toEqual([
      "Date,Shopper,Amount,Paid from,Status,Items,Note",
      "2026-11-02,Anis,300.00,Mess fund,Approved,,",
      "2026-11-04,Anis,50.00,Mess fund,Pending,,",
    ]);
  });

  it("exports your own bill; others' bills are for managers", async () => {
    const { aUser, bUser, a, mess, november } = await messInNovember();
    const mine = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/export/statement/me`)
      .set(authHeader(bUser));
    expect(mine.status).toBe(200);
    expect(mine.headers["content-disposition"]).toContain("2026-11-bill-bashir.csv");
    expect(mine.text).toContain("Carried in,,-500.00");
    expect(mine.text).toContain("2026-11-03,Electricity: October bill,900.00,-300.00");
    expect(mine.text).toContain("Balance so far,Due,-900.00");

    const theirs = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/export/statement/${a.id}`)
      .set(authHeader(bUser));
    expect(theirs.status).toBe(404);
    const asManager = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/export/statement/${a.id}`)
      .set(authHeader(aUser));
    expect(asManager.status).toBe(200);
  });
});
