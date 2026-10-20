import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";

const base = (messId: string) => `/api/v1/messes/${messId}/deposits`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T08:00:00Z")); // 14:00 in Dhaka
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, ownerMember, month } = await createMess(admin);
  const user = await createUser({ name: "Payer" });
  const member = await addMember(mess.id, user);
  return { admin, adminMember: ownerMember, mess, month, user, member };
}

describe("POST /deposits", () => {
  it("sends a member's deposit to the managers for confirmation", async () => {
    const { admin, user, mess } = await setup();
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", amount: "3000", method: "BKASH", transactionRef: "9AX7K2" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Deposit sent for confirmation");
    expect(res.body.data).toMatchObject({
      date: "2026-10-19",
      amount: "3000.00",
      method: "BKASH",
      transactionRef: "9AX7K2",
      status: "PENDING",
      member: { name: "Payer" },
      receivedBy: null,
      canEdit: true,
      canReview: false,
    });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: admin.id } })).toMatchObject({
      type: "DEPOSIT_SUBMITTED",
      title: "Payer paid ৳3000.00",
    });
  });

  it("lets a manager record a deposit for a member, approved straight away", async () => {
    const { admin, user, member, mess } = await setup();
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(admin))
      .send({ date: "2026-10-05", amount: 2500, memberId: member.id });
    expect(res.body.data).toMatchObject({
      date: "2026-10-05",
      status: "APPROVED",
      method: "CASH",
      receivedBy: { name: "Admin" },
    });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      type: "DEPOSIT_APPROVED",
      title: "Your deposit of ৳2500.00 was recorded",
    });
  });

  it("is approved straight away when the mess doesn't require approval", async () => {
    const { user, mess } = await setup();
    await prisma.messSetting.update({ where: { messId: mess.id }, data: { requireDepositApproval: false } });
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", amount: 100 });
    expect(res.body.data).toMatchObject({ status: "APPROVED", receivedBy: null });
  });

  it("rejects future dates, closed months, other members and a transaction counted twice", async () => {
    const { user, mess, month, adminMember } = await setup();
    const post = (body: object) => request(app).post(base(mess.id)).set(authHeader(user)).send(body);

    expect((await post({ date: "2026-10-20", amount: 100 })).body.code).toBe("DATE_IN_FUTURE");
    expect((await post({ date: "2026-10-19", amount: 100, memberId: adminMember.id })).status).toBe(403);
    expect((await post({ date: "2026-10-19", amount: "0" })).status).toBe(400);

    await post({ date: "2026-10-19", amount: 500, method: "NAGAD", transactionRef: "N123" });
    const twice = await post({ date: "2026-10-18", amount: 500, method: "NAGAD", transactionRef: "n123" });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe("DUPLICATE_TRANSACTION");
    // Cash has no transaction id to clash on, and other methods are separate.
    expect(
      (await post({ date: "2026-10-19", amount: 500, method: "BKASH", transactionRef: "N123" })).status,
    ).toBe(201);

    await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
    expect((await post({ date: "2026-10-19", amount: 100 })).body.code).toBe("MONTH_CLOSED");
  });

  it("uses the mess timezone for the day", async () => {
    const { user, mess } = await setup();
    // 20:00 UTC on Oct 19 is already Oct 20 in Dhaka, so "today" is the 20th.
    vi.setSystemTime(new Date("2026-10-19T20:00:00Z"));
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-20", amount: 100 });
    expect(res.status).toBe(201);
    expect(res.body.data.date).toBe("2026-10-20");
  });
});

describe("reviewing, editing and deleting", () => {
  it("lets managers confirm or reject, and the member fix and resubmit", async () => {
    const { admin, user, mess } = await setup();
    const a = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", amount: 1000 });
    const b = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", amount: 2000 });

    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/${a.body.data.id}/approve`)
          .set(authHeader(user))
      ).status,
    ).toBe(403);
    const confirmed = await request(app)
      .post(`${base(mess.id)}/${a.body.data.id}/approve`)
      .set(authHeader(admin));
    expect(confirmed.body.data).toMatchObject({ status: "APPROVED", receivedBy: { name: "Admin" } });
    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/${a.body.data.id}/approve`)
          .set(authHeader(admin))
      ).status,
    ).toBe(409);

    const rejected = await request(app)
      .post(`${base(mess.id)}/${b.body.data.id}/reject`)
      .set(authHeader(admin))
      .send({ reason: "I only got 1500" });
    expect(rejected.body.data).toMatchObject({ status: "REJECTED", rejectionReason: "I only got 1500" });

    const fixed = await request(app)
      .patch(`${base(mess.id)}/${b.body.data.id}`)
      .set(authHeader(user))
      .send({ amount: "1500" });
    expect(fixed.body.data).toMatchObject({
      amount: "1500.00",
      status: "PENDING",
      rejectionReason: null,
      receivedBy: null,
    });

    const locked = await request(app)
      .patch(`${base(mess.id)}/${a.body.data.id}`)
      .set(authHeader(user))
      .send({ amount: 1 });
    expect(locked.body.code).toBe("NOT_EDITABLE");
    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/${a.body.data.id}`)
          .set(authHeader(user))
      ).status,
    ).toBe(403);

    const byManager = await request(app)
      .patch(`${base(mess.id)}/${a.body.data.id}`)
      .set(authHeader(admin))
      .send({ note: "Cash" });
    expect(byManager.body.data).toMatchObject({ note: "Cash", status: "APPROVED" });
    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/${a.body.data.id}`)
          .set(authHeader(admin))
      ).status,
    ).toBe(200);

    const types = (
      await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } })
    ).map((n) => n.type);
    expect(types).toEqual(["DEPOSIT_APPROVED", "DEPOSIT_REJECTED"]);
    expect(
      await prisma.auditLog.count({ where: { messId: mess.id, action: { startsWith: "DEPOSIT_" } } }),
    ).toBe(7);
  });

  it("keeps other members' deposits private", async () => {
    const { admin, user, mess } = await setup();
    const theirs = await request(app)
      .post(base(mess.id))
      .set(authHeader(admin))
      .send({ date: "2026-10-19", amount: 100 });
    const res = await request(app)
      .get(`${base(mess.id)}/${theirs.body.data.id}`)
      .set(authHeader(user));
    expect(res.status).toBe(404);
    const patch = await request(app)
      .patch(`${base(mess.id)}/${theirs.body.data.id}`)
      .set(authHeader(user))
      .send({ amount: 1 });
    expect(patch.status).toBe(404);
  });
});

describe("listing and totals", () => {
  it("shows members their own deposits, managers everyone's, and sums the month", async () => {
    const { admin, user, member, mess, month } = await setup();
    const post = (as: typeof user, body: object) =>
      request(app).post(base(mess.id)).set(authHeader(as)).send(body);
    await post(admin, { date: "2026-10-02", amount: "2000", memberId: member.id });
    await post(admin, { date: "2026-10-03", amount: "3500.50", method: "BKASH", transactionRef: "X1" });
    await post(user, { date: "2026-10-19", amount: "500", method: "NAGAD", transactionRef: "Y1" });

    const mine = await request(app).get(base(mess.id)).set(authHeader(user));
    expect(mine.body.data.items.map((d: { amount: string }) => d.amount)).toEqual(["500.00", "2000.00"]);
    const filtered = await request(app)
      .get(`${base(mess.id)}?memberId=${member.id}&status=APPROVED`)
      .set(authHeader(admin));
    expect(filtered.body.data.items).toHaveLength(1);
    const all = await request(app).get(base(mess.id)).set(authHeader(admin));
    expect(all.body.data.items).toHaveLength(3);

    const summary = await request(app)
      .get(`${base(mess.id)}/summary?monthId=${month.id}`)
      .set(authHeader(admin));
    expect(summary.body.data).toMatchObject({
      approved: { total: "5500.50", count: 2 },
      pending: { total: "500.00", count: 1 },
      byMethod: { CASH: "2000.00", BKASH: "3500.50", NAGAD: "0.00" },
      byMember: [
        { member: { name: "Admin" }, total: "3500.50", count: 1 },
        { member: { name: "Payer" }, total: "2000.00", count: 1 },
      ],
    });
    const memberView = await request(app)
      .get(`${base(mess.id)}/summary`)
      .set(authHeader(user));
    expect(memberView.body.data).toMatchObject({
      approved: { total: "2000.00", count: 1 },
      pending: { total: "500.00", count: 1 },
    });
    expect(memberView.body.data.byMember).toHaveLength(2);
  });
});
