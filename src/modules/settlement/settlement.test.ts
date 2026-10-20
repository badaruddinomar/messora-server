import { ApprovalStatus, MonthStatus } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { runDueReminders } from "../../jobs/due-reminder.job.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-11-05T08:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * A closed October: 1500 of bazar shared equally because nobody ate (500 each). Anis paid 1200
 * (+700), Bashir 0 (−500), Chhoton 500 (settled). Cash in hand: 1700 deposits − 1500 bazar = 200.
 */
async function closedOctober() {
  const aUser = await createUser({ name: "Anis" });
  const { mess, ownerMember: a, month } = await createMess(aUser);
  await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: false } });
  const bUser = await createUser({ name: "Bashir" });
  const cUser = await createUser({ name: "Chhoton" });
  const b = await addMember(mess.id, bUser);
  const c = await addMember(mess.id, cUser);
  await prisma.bazar.create({
    data: {
      messId: mess.id,
      monthId: month.id,
      shopperId: a.id,
      date: toDbDate("2026-10-03"),
      totalAmount: 1500,
      status: ApprovalStatus.APPROVED,
      createdById: aUser.id,
    },
  });
  for (const [m, amount] of [
    [a, 1200],
    [c, 500],
  ] as const) {
    await prisma.deposit.create({
      data: { messId: mess.id, monthId: month.id, memberId: m.id, amount, status: ApprovalStatus.APPROVED },
    });
  }
  await request(app)
    .post(`${base(mess.id)}/months/${month.id}/start-closing`)
    .set(authHeader(aUser));
  await request(app)
    .post(`${base(mess.id)}/months/${month.id}/close`)
    .set(authHeader(aUser))
    .send({ version: 1 });
  return { aUser, bUser, cUser, a, b, c, mess, month };
}

const pay = (messId: string, monthId: string, as: Parameters<typeof authHeader>[0], body: object) =>
  request(app)
    .post(`${base(messId)}/months/${monthId}/settlements`)
    .set(authHeader(as))
    .send(body);

describe("settlements", () => {
  it("lists who owes and who's owed, and records dues and refunds until settled", async () => {
    const { aUser, bUser, a, b, mess, month } = await closedOctober();

    const list = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/settlements`)
      .set(authHeader(aUser));
    expect(list.body.data).toMatchObject({
      collectable: true,
      totals: { dueToMess: "500.00", owedToMembers: "700.00" },
    });
    expect(
      list.body.data.rows.map(
        (r: {
          member: { name: string };
          direction: string | null;
          remaining: string;
          isSettled: boolean;
        }) => [r.member.name, r.direction, r.remaining, r.isSettled],
      ),
    ).toEqual([
      ["Bashir", "MEMBER_TO_MESS", "500.00", false],
      ["Chhoton", null, "0.00", true],
      ["Anis", "MESS_TO_MEMBER", "700.00", false],
    ]);

    const part = await pay(mess.id, month.id, aUser, {
      memberId: b.id,
      amount: "300",
      method: "BKASH",
      transactionRef: "TX1",
    });
    expect(part.status).toBe(201);
    expect(part.body.data).toMatchObject({ settledAmount: "300.00", remaining: "200.00", isSettled: false });
    expect((await pay(mess.id, month.id, aUser, { memberId: b.id, amount: "250" })).body.code).toBe(
      "OVERPAYMENT",
    );
    const rest = await pay(mess.id, month.id, aUser, { memberId: b.id, amount: "200" });
    expect(rest.body.data).toMatchObject({ isSettled: true, remaining: "0.00" });
    expect((await pay(mess.id, month.id, aUser, { memberId: b.id, amount: "1" })).status).toBe(409);

    const refund = await pay(mess.id, month.id, aUser, { memberId: a.id, amount: "700" });
    expect(refund.body.data).toMatchObject({ isSettled: true, payments: [{ direction: "MESS_TO_MEMBER" }] });

    const note = await prisma.notification.findFirstOrThrow({
      where: { userId: bUser.id, type: "SETTLEMENT_RECORDED" },
      orderBy: { createdAt: "desc" },
    });
    expect(note.body).toBe("Your October 2026 balance is settled.");

    // The payments are November's cash, and October's balances no longer carry over.
    const november = await prisma.messMonth.findFirstOrThrow({ where: { messId: mess.id, month: 11 } });
    const preview = await request(app)
      .get(`${base(mess.id)}/months/${november.id}/preview`)
      .set(authHeader(aUser));
    expect(preview.body.data.cash).toMatchObject({
      openingCash: "200.00",
      settlementsIn: "500.00",
      settlementsOut: "700.00",
      closingCash: "0.00",
    });
    expect(
      preview.body.data.members.every((m: { openingBalance: string }) => m.openingBalance === "0.00"),
    ).toBe(true);
  });

  it("is managers only to record; members see their own row", async () => {
    const { bUser, b, mess, month } = await closedOctober();
    expect((await pay(mess.id, month.id, bUser, { memberId: b.id, amount: "100" })).status).toBe(403);
    const mine = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/settlements`)
      .set(authHeader(bUser));
    expect(mine.body.data.rows).toHaveLength(1);
  });

  it("can undo a payment while its month is open, but not once the balance has carried over", async () => {
    const { aUser, b, mess, month } = await closedOctober();
    const paid = await pay(mess.id, month.id, aUser, { memberId: b.id, amount: "500" });
    const paymentId = paid.body.data.payments[0].id;
    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/settlements/${paymentId}`)
          .set(authHeader(aUser))
      ).status,
    ).toBe(200);
    expect((await prisma.memberMonthSummary.findFirstOrThrow({ where: { memberId: b.id } })).isSettled).toBe(
      false,
    );

    await prisma.messMonth.updateMany({
      where: { messId: mess.id, month: 11 },
      data: { status: MonthStatus.CLOSED },
    });
    const late = await pay(mess.id, month.id, aUser, { memberId: b.id, amount: "500" });
    expect(late.body.code).toBe("BALANCE_CARRIED_OVER");
  });
});

describe("fund handover", () => {
  it("hands the month's cash to the next manager, who confirms or disputes it", async () => {
    const { aUser, bUser, cUser, b, mess, month } = await closedOctober();
    const handed = await request(app)
      .post(`${base(mess.id)}/months/${month.id}/handovers`)
      .set(authHeader(aUser))
      .send({ toMemberId: b.id, handedAmount: "150", note: "50 spent on gas" });
    expect(handed.status).toBe(201);
    expect(handed.body.data).toMatchObject({
      expectedAmount: "200.00",
      handedAmount: "150.00",
      difference: "-50.00",
      status: "PENDING",
    });
    expect(
      await prisma.notification.findFirstOrThrow({ where: { userId: bUser.id, type: "FUND_HANDOVER" } }),
    ).toMatchObject({
      title: "Anis handed you ৳150.00",
    });

    const again = await request(app)
      .post(`${base(mess.id)}/months/${month.id}/handovers`)
      .set(authHeader(aUser))
      .send({ toMemberId: b.id, handedAmount: "700" });
    expect(again.status).toBe(409);

    const id = handed.body.data.id;
    const notTheirs = await request(app)
      .post(`${base(mess.id)}/handovers/${id}/respond`)
      .set(authHeader(cUser))
      .send({ status: "CONFIRMED" });
    expect(notTheirs.status).toBe(403);
    const noReason = await request(app)
      .post(`${base(mess.id)}/handovers/${id}/respond`)
      .set(authHeader(bUser))
      .send({ status: "DISPUTED" });
    expect(noReason.status).toBe(400);
    const disputed = await request(app)
      .post(`${base(mess.id)}/handovers/${id}/respond`)
      .set(authHeader(bUser))
      .send({ status: "DISPUTED", note: "I only got 100" });
    expect(disputed.body.data).toMatchObject({
      status: "DISPUTED",
      note: "I only got 100",
      canRespond: false,
    });

    const list = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/handovers`)
      .set(authHeader(cUser));
    expect(list.body.data).toHaveLength(1);
  });
});

describe("runDueReminders", () => {
  it("reminds members who owe on the mess's reminder day, once", async () => {
    const { bUser, aUser, mess } = await closedOctober();
    await prisma.messSetting.update({ where: { messId: mess.id }, data: { dueReminderDay: 7 } });

    setNow("2026-11-06T05:00:00Z"); // the 6th
    expect((await runDueReminders()).sent).toBe(0);
    setNow("2026-11-07T02:00:00Z"); // 08:00 in Dhaka on the 7th: too early
    expect((await runDueReminders()).sent).toBe(0);
    setNow("2026-11-07T04:00:00Z"); // 10:00
    expect((await runDueReminders()).sent).toBe(1);
    expect((await runDueReminders()).sent).toBe(0);

    expect(
      await prisma.notification.findFirstOrThrow({ where: { userId: bUser.id, type: "DUE_REMINDER" } }),
    ).toMatchObject({
      title: "You owe the mess ৳500.00",
    });
    expect(await prisma.notification.count({ where: { userId: aUser.id, type: "DUE_REMINDER" } })).toBe(0);
  });
});
