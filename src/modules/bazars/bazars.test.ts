import { MessRole } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { storage } from "../../lib/storage/index.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { tinyJpeg } from "../../test/files.js";
import { toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}/bazars`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, ownerMember, month } = await createMess(admin);
  const user = await createUser({ name: "Shopper" });
  const member = await addMember(mess.id, user);
  return { admin, adminMember: ownerMember, mess, month, user, member };
}

const items = [
  { name: "Rice", quantity: 5, unit: "kg", totalPrice: "350.50" },
  { name: "Eggs", quantity: "12", unit: "pcs", totalPrice: 144 },
];

async function uploadReceipt(messId: string, user: Parameters<typeof authHeader>[0]) {
  const file = tinyJpeg();
  const res = await request(app)
    .post(`/api/v1/messes/${messId}/uploads`)
    .set(authHeader(user))
    .send({ purpose: "receipt", contentType: "image/jpeg", size: file.length });
  await request(app).put(res.body.data.upload.url).set("Content-Type", "image/jpeg").send(file);
  return res.body.data.key as string;
}

describe("POST /bazars", () => {
  it("adds an itemised bazar for approval, with a receipt, and tells the managers", async () => {
    const { admin, user, mess } = await setup();
    const receiptKey = await uploadReceipt(mess.id, user);
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", items, receiptKey, note: "Weekly" });

    expect(res.status).toBe(201);
    expect(res.body.message).toBe("Bazar sent for approval");
    expect(res.body.data).toMatchObject({
      date: "2026-10-19",
      totalAmount: "494.50",
      paidFrom: "MESS_FUND",
      status: "PENDING",
      shopper: { name: "Shopper" },
      canEdit: true,
      canReview: false,
    });
    expect(res.body.data.items).toEqual([
      expect.objectContaining({ name: "Rice", quantity: "5", unit: "kg", totalPrice: "350.50" }),
      expect.objectContaining({ name: "Eggs", quantity: "12", totalPrice: "144.00" }),
    ]);
    expect(res.body.data.receiptUrl).toMatch(/^\/api\/v1\/files\/messes\//);
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: admin.id } })).toMatchObject({
      type: "BAZAR_SUBMITTED",
      title: "Shopper added a bazar",
    });
  });

  it("checks the total against the items, or takes a quick total", async () => {
    const { user, mess } = await setup();
    const mismatch = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", items, totalAmount: "500" });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe("TOTAL_MISMATCH");

    const quick = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 820, paidFrom: "OWN_POCKET" });
    expect(quick.body.data).toMatchObject({ totalAmount: "820.00", paidFrom: "OWN_POCKET", items: [] });

    const empty = await request(app).post(base(mess.id)).set(authHeader(user)).send({ date: "2026-10-19" });
    expect(empty.status).toBe(400);

    const bad = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: "12.345" });
    expect(bad.status).toBe(400);
  });

  it("rejects future dates, closed months, receipts that weren't uploaded and other people", async () => {
    const { user, mess, month, adminMember } = await setup();
    const future = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-20", totalAmount: 100 });
    expect(future.body.code).toBe("DATE_IN_FUTURE");

    const receipt = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100, receiptKey: `messes/${mess.id}/receipts/nope.jpg` });
    expect(receipt.body.code).toBe("RECEIPT_NOT_FOUND");

    const other = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100, shopperId: adminMember.id });
    expect(other.status).toBe(403);

    await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
    const closed = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100 });
    expect(closed.body.code).toBe("MONTH_CLOSED");
  });

  it("is approved straight away when a manager adds it or approval is off", async () => {
    const { admin, user, member, mess } = await setup();
    const byManager = await request(app)
      .post(base(mess.id))
      .set(authHeader(admin))
      .send({ date: "2026-10-18", totalAmount: 300, shopperId: member.id });
    expect(byManager.body.data).toMatchObject({ status: "APPROVED", approvedBy: { name: "Admin" } });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      title: "A manager recorded your bazar",
    });

    await prisma.messSetting.update({ where: { messId: mess.id }, data: { requireBazarApproval: false } });
    const noApproval = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100 });
    expect(noApproval.body.data).toMatchObject({ status: "APPROVED", approvedBy: null });
  });

  it("marks the shopper's bazar duty for that day as done", async () => {
    const { user, member, mess, month } = await setup();
    await prisma.bazarSchedule.create({
      data: { messId: mess.id, monthId: month.id, memberId: member.id, date: toDbDate("2026-10-19") },
    });
    await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100 });
    expect((await prisma.bazarSchedule.findFirstOrThrow({ where: { memberId: member.id } })).isDone).toBe(
      true,
    );
  });
});

describe("reviewing", () => {
  it("lets managers approve or reject (with a reason), and tells the shopper", async () => {
    const { admin, user, mess } = await setup();
    const a = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100 });
    const b = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 200 });

    const denied = await request(app)
      .post(`${base(mess.id)}/${a.body.data.id}/approve`)
      .set(authHeader(user));
    expect(denied.status).toBe(403);

    const approved = await request(app)
      .post(`${base(mess.id)}/${a.body.data.id}/approve`)
      .set(authHeader(admin));
    expect(approved.body.data).toMatchObject({ status: "APPROVED", approvedBy: { name: "Admin" } });
    const again = await request(app)
      .post(`${base(mess.id)}/${a.body.data.id}/approve`)
      .set(authHeader(admin));
    expect(again.status).toBe(409);

    const noReason = await request(app)
      .post(`${base(mess.id)}/${b.body.data.id}/reject`)
      .set(authHeader(admin))
      .send({});
    expect(noReason.status).toBe(400);
    const rejected = await request(app)
      .post(`${base(mess.id)}/${b.body.data.id}/reject`)
      .set(authHeader(admin))
      .send({ reason: "Receipt missing" });
    expect(rejected.body.data).toMatchObject({ status: "REJECTED", rejectionReason: "Receipt missing" });

    const types = (
      await prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } })
    ).map((n) => n.type);
    expect(types).toEqual(["BAZAR_APPROVED", "BAZAR_REJECTED"]);
  });

  it("gives the month manager manager powers", async () => {
    const { user, mess, month } = await setup();
    const mmUser = await createUser();
    const mm = await addMember(mess.id, mmUser, { role: MessRole.MEMBER });
    await prisma.messMonth.update({ where: { id: month.id }, data: { managerId: mm.id } });
    const b = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100 });
    const res = await request(app)
      .post(`${base(mess.id)}/${b.body.data.id}/approve`)
      .set(authHeader(mmUser));
    expect(res.status).toBe(200);
  });
});

describe("editing and deleting", () => {
  it("lets the creator edit while pending, and resubmit after a rejection", async () => {
    const { admin, user, mess } = await setup();
    const b = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", items });
    const id = b.body.data.id;

    const edited = await request(app)
      .patch(`${base(mess.id)}/${id}`)
      .set(authHeader(user))
      .send({ items: [{ name: "Fish", totalPrice: "600" }] });
    expect(edited.body.data).toMatchObject({
      totalAmount: "600.00",
      items: [expect.objectContaining({ name: "Fish" })],
    });

    const totalOnly = await request(app)
      .patch(`${base(mess.id)}/${id}`)
      .set(authHeader(user))
      .send({ totalAmount: 700 });
    expect(totalOnly.body.code).toBe("TOTAL_MISMATCH");

    await request(app)
      .post(`${base(mess.id)}/${id}/reject`)
      .set(authHeader(admin))
      .send({ reason: "Wrong date" });
    const resubmitted = await request(app)
      .patch(`${base(mess.id)}/${id}`)
      .set(authHeader(user))
      .send({ date: "2026-10-18" });
    expect(resubmitted.body.data).toMatchObject({
      date: "2026-10-18",
      status: "PENDING",
      rejectionReason: null,
    });

    await request(app)
      .post(`${base(mess.id)}/${id}/approve`)
      .set(authHeader(admin));
    const locked = await request(app)
      .patch(`${base(mess.id)}/${id}`)
      .set(authHeader(user))
      .send({ note: "x" });
    expect(locked.status).toBe(403);
    expect(locked.body.code).toBe("NOT_EDITABLE");

    const byManager = await request(app)
      .patch(`${base(mess.id)}/${id}`)
      .set(authHeader(admin))
      .send({ note: "Checked" });
    expect(byManager.body.data).toMatchObject({ note: "Checked", status: "APPROVED" });
    expect(await prisma.auditLog.count({ where: { entityId: id, action: "BAZAR_UPDATED" } })).toBe(3);
  });

  it("stops other members, and deletes the receipt with the bazar", async () => {
    const { user, mess } = await setup();
    const receiptKey = await uploadReceipt(mess.id, user);
    const b = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100, receiptKey });

    const stranger = await createUser();
    await addMember(mess.id, stranger);
    const denied = await request(app)
      .delete(`${base(mess.id)}/${b.body.data.id}`)
      .set(authHeader(stranger));
    expect(denied.status).toBe(403);

    const deleted = await request(app)
      .delete(`${base(mess.id)}/${b.body.data.id}`)
      .set(authHeader(user));
    expect(deleted.status).toBe(200);
    await vi.waitFor(async () => expect(await storage.stat(receiptKey)).toBeNull());
  });

  it("won't take another mess's receipt", async () => {
    const { user, mess, admin } = await setup();
    const other = await createMess(admin);
    const key = await uploadReceipt(other.mess.id, admin);
    const res = await request(app)
      .post(base(mess.id))
      .set(authHeader(user))
      .send({ date: "2026-10-19", totalAmount: 100, receiptKey: key });
    expect(res.body.code).toBe("RECEIPT_NOT_FOUND");
  });
});

describe("listing and totals", () => {
  it("filters the list and sums the month, approved only for the meal rate", async () => {
    const { admin, user, member, mess, month } = await setup();
    const post = (as: typeof user, body: object) =>
      request(app).post(base(mess.id)).set(authHeader(as)).send(body);
    await post(admin, { date: "2026-10-10", totalAmount: "1000", shopperId: member.id });
    await post(admin, { date: "2026-10-12", totalAmount: "250.25", paidFrom: "OWN_POCKET" });
    await post(user, { date: "2026-10-19", totalAmount: "99" });

    const pending = await request(app)
      .get(`${base(mess.id)}?status=PENDING`)
      .set(authHeader(user));
    expect(pending.body.data.items.map((b: { totalAmount: string }) => b.totalAmount)).toEqual(["99.00"]);

    const page = await request(app)
      .get(`${base(mess.id)}?limit=2`)
      .set(authHeader(user));
    expect(page.body.data.items.map((b: { date: string }) => b.date)).toEqual(["2026-10-19", "2026-10-12"]);
    expect(page.body.data.nextCursor).toBeTruthy();

    const byShopper = await request(app)
      .get(`${base(mess.id)}?shopperId=${member.id}`)
      .set(authHeader(user));
    expect(byShopper.body.data.items).toHaveLength(2);

    const summary = await request(app)
      .get(`${base(mess.id)}/summary?monthId=${month.id}`)
      .set(authHeader(user));
    expect(summary.body.data).toMatchObject({
      approved: { total: "1250.25", count: 2 },
      pending: { total: "99.00", count: 1 },
      byPaidFrom: { MESS_FUND: "1000.00", OWN_POCKET: "250.25" },
      byShopper: [
        { member: { name: "Shopper" }, total: "1000.00", count: 1 },
        { member: { name: "Admin" }, total: "250.25", count: 1 },
      ],
    });
    const current = await request(app)
      .get(`${base(mess.id)}/summary`)
      .set(authHeader(user));
    expect(current.body.data.monthId).toBe(month.id);
  });
});
