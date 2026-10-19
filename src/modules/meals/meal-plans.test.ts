import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createSlots, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";
import { generateMealEntries } from "./meals.generation.js";

const base = (messId: string) => `/api/v1/messes/${messId}/meals`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 14:00 in Dhaka: today's breakfast and lunch are past their cutoff, dinner isn't.
  vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, ownerMember } = await createMess(admin);
  const slots = await createSlots(mess.id);
  const user = await createUser({ name: "Member" });
  const member = await addMember(mess.id, user);
  await generateMealEntries(prisma, mess.id, "2026-10-17", "2026-10-26");
  return { admin, adminMember: ownerMember, mess, slots, user, member };
}

/** quantity per slot name for one member and day, e.g. { Breakfast: 1, Lunch: 1, Dinner: 0 } */
async function mealsOn(memberId: string, date: string) {
  const entries = await prisma.mealEntry.findMany({
    where: { memberId, date: toDbDate(date) },
    include: { slot: true },
  });
  return Object.fromEntries(entries.map((e) => [e.slot.name, e.quantity.toNumber()]));
}

describe("meal-off periods", () => {
  it("turns off upcoming meals in the range, and leaves eaten ones alone", async () => {
    const { user, member, mess } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-19", toDate: "2026-10-20", reason: "Going home" });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      fromDate: "2026-10-19",
      toDate: "2026-10-20",
      reason: "Going home",
    });
    expect(await mealsOn(member.id, "2026-10-19")).toEqual({ Breakfast: 1, Lunch: 1, Dinner: 0 });
    expect(await mealsOn(member.id, "2026-10-20")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
    expect(await mealsOn(member.id, "2026-10-21")).toEqual({ Breakfast: 1, Lunch: 1, Dinner: 1 });

    // Days generated later start at 0 too.
    await prisma.mealEntry.deleteMany({ where: { memberId: member.id, date: toDbDate("2026-10-20") } });
    await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-20");
    expect(await mealsOn(member.id, "2026-10-20")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
  });

  it("rejects overlaps and members back-dating", async () => {
    const { user, mess } = await setup();
    await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-21", toDate: "2026-10-23" });

    const overlap = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-23", toDate: "2026-10-25" });
    expect(overlap.status).toBe(409);

    const past = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-18", toDate: "2026-10-18" });
    expect(past.status).toBe(422);

    const reversed = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-25", toDate: "2026-10-24" });
    expect(reversed.status).toBe(400);
  });

  it("lets managers back-date a meal-off for someone, within open months", async () => {
    const { admin, member, mess } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(admin))
      .send({ memberId: member.id, fromDate: "2026-10-17", toDate: "2026-10-19" });

    expect(res.status).toBe(201);
    expect(await mealsOn(member.id, "2026-10-17")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
    expect(await mealsOn(member.id, "2026-10-19")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
    expect(await prisma.auditLog.count({ where: { messId: mess.id, action: "MEAL_OFF_CREATED" } })).toBe(1);
  });

  it("stops members from planning for others", async () => {
    const { user, adminMember, mess } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ memberId: adminMember.id, fromDate: "2026-10-21", toDate: "2026-10-21" });
    expect(res.status).toBe(403);
  });

  it("cancels an upcoming meal-off and ends a running one", async () => {
    const { user, member, mess } = await setup();
    const upcoming = await request(app)
      .post(`${base(mess.id)}/off`)
      .set(authHeader(user))
      .send({ fromDate: "2026-10-22", toDate: "2026-10-22" });
    const cancelled = await request(app)
      .delete(`${base(mess.id)}/off/${upcoming.body.data.id}`)
      .set(authHeader(user));
    expect(cancelled.body.data).toEqual({ ended: false });
    expect(await mealsOn(member.id, "2026-10-22")).toEqual({ Breakfast: 1, Lunch: 1, Dinner: 1 });

    const running = await prisma.mealOffPeriod.create({
      data: {
        messId: mess.id,
        memberId: member.id,
        fromDate: toDbDate("2026-10-18"),
        toDate: toDbDate("2026-10-20"),
      },
    });
    await prisma.mealEntry.updateMany({
      where: { memberId: member.id, date: { gte: toDbDate("2026-10-18"), lte: toDbDate("2026-10-20") } },
      data: { quantity: 0 },
    });
    const ended = await request(app)
      .delete(`${base(mess.id)}/off/${running.id}`)
      .set(authHeader(user));
    expect(ended.body.data).toEqual({ ended: true });
    expect(await prisma.mealOffPeriod.findUniqueOrThrow({ where: { id: running.id } })).toMatchObject({
      toDate: toDbDate("2026-10-18"),
    });
    expect(await mealsOn(member.id, "2026-10-18")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
    expect(await mealsOn(member.id, "2026-10-19")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 1 });
    expect(await mealsOn(member.id, "2026-10-20")).toEqual({ Breakfast: 1, Lunch: 1, Dinner: 1 });
  });

  it("lists my upcoming meal-offs; managers see everyone's", async () => {
    const { admin, user, member, adminMember, mess } = await setup();
    for (const [memberId, fromDate] of [
      [member.id, "2026-10-21"],
      [adminMember.id, "2026-10-22"],
    ]) {
      await prisma.mealOffPeriod.create({
        data: { messId: mess.id, memberId, fromDate: toDbDate(fromDate), toDate: toDbDate(fromDate) },
      });
    }
    const mine = await request(app)
      .get(`${base(mess.id)}/off`)
      .set(authHeader(user));
    expect(mine.body.data.map((p: { member: { id: string } }) => p.member.id)).toEqual([member.id]);

    const all = await request(app)
      .get(`${base(mess.id)}/off`)
      .set(authHeader(admin));
    expect(all.body.data).toHaveLength(2);
    const past = await request(app)
      .get(`${base(mess.id)}/off?when=past`)
      .set(authHeader(admin));
    expect(past.body.data).toHaveLength(0);
  });
});

describe("PATCH /meals/preference", () => {
  it("switches upcoming usual meals, keeping custom amounts and meal-offs", async () => {
    const { user, member, mess, slots } = await setup();
    await prisma.mealEntry.update({
      where: {
        memberId_slotId_date: { memberId: member.id, slotId: slots.lunch.id, date: toDbDate("2026-10-21") },
      },
      data: { quantity: 2 },
    });

    const off = await request(app)
      .patch(`${base(mess.id)}/preference`)
      .set(authHeader(user))
      .send({ defaultMealOn: false });
    expect(off.status).toBe(200);
    expect(off.body.data.defaultMealOn).toBe(false);
    expect(await mealsOn(member.id, "2026-10-19")).toEqual({ Breakfast: 1, Lunch: 1, Dinner: 0 });
    expect(await mealsOn(member.id, "2026-10-21")).toEqual({ Breakfast: 0, Lunch: 2, Dinner: 0 });

    await prisma.mealOffPeriod.create({
      data: {
        messId: mess.id,
        memberId: member.id,
        fromDate: toDbDate("2026-10-22"),
        toDate: toDbDate("2026-10-22"),
      },
    });
    await request(app)
      .patch(`${base(mess.id)}/preference`)
      .set(authHeader(user))
      .send({ defaultMealOn: true });
    expect(await mealsOn(member.id, "2026-10-21")).toEqual({ Breakfast: 1, Lunch: 2, Dinner: 1 });
    expect(await mealsOn(member.id, "2026-10-22")).toEqual({ Breakfast: 0, Lunch: 0, Dinner: 0 });
  });
});

describe("meal requests", () => {
  it("goes to the managers and back to the member", async () => {
    const { admin, user, mess, slots } = await setup();
    const created = await request(app)
      .post(`${base(mess.id)}/requests`)
      .set(authHeader(user))
      .send({ date: "2026-10-20", slotId: slots.lunch.id, request: "Fish curry, please" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      status: "PENDING",
      slot: { name: "Lunch" },
      member: { name: "Member" },
    });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: admin.id } })).toMatchObject({
      type: "MEAL_REQUEST",
      title: "Meal request from Member",
      body: "Lunch, 2026-10-20: Fish curry, please",
    });

    const denied = await request(app)
      .patch(`${base(mess.id)}/requests/${created.body.data.id}`)
      .set(authHeader(user))
      .send({ status: "APPROVED" });
    expect(denied.status).toBe(403);

    const answered = await request(app)
      .patch(`${base(mess.id)}/requests/${created.body.data.id}`)
      .set(authHeader(admin))
      .send({ status: "APPROVED", response: "Done" });
    expect(answered.body.data).toMatchObject({
      status: "APPROVED",
      response: "Done",
      respondedBy: { name: "Admin" },
    });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      type: "MEAL_REQUEST_RESPONDED",
      title: "Your meal request was approved",
    });

    const again = await request(app)
      .patch(`${base(mess.id)}/requests/${created.body.data.id}`)
      .set(authHeader(admin))
      .send({ status: "REJECTED" });
    expect(again.status).toBe(409);
  });

  it("lists my requests (everyone's for managers) and lets me withdraw a pending one", async () => {
    const { admin, user, mess } = await setup();
    const mine = await request(app)
      .post(`${base(mess.id)}/requests`)
      .set(authHeader(user))
      .send({ date: "2026-10-19", request: "Late dinner" });
    await request(app)
      .post(`${base(mess.id)}/requests`)
      .set(authHeader(admin))
      .send({ date: "2026-10-19", request: "No onions" });

    const listMine = await request(app)
      .get(`${base(mess.id)}/requests`)
      .set(authHeader(user));
    expect(listMine.body.data.items).toHaveLength(1);
    const listAll = await request(app)
      .get(`${base(mess.id)}/requests?status=PENDING`)
      .set(authHeader(admin));
    expect(listAll.body.data.items).toHaveLength(2);

    const notMine = await request(app)
      .delete(`${base(mess.id)}/requests/${mine.body.data.id}`)
      .set(authHeader(admin));
    expect(notMine.status).toBe(403);
    const withdrawn = await request(app)
      .delete(`${base(mess.id)}/requests/${mine.body.data.id}`)
      .set(authHeader(user));
    expect(withdrawn.status).toBe(200);
  });

  it("only takes requests for today or later", async () => {
    const { user, mess } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/requests`)
      .set(authHeader(user))
      .send({ date: "2026-10-18", request: "Too late" });
    expect(res.status).toBe(422);
  });
});

describe("daily menu", () => {
  it("posts a menu, announces it once, and lists it", async () => {
    const { admin, user, mess, slots } = await setup();
    const posted = await request(app)
      .put(`${base(mess.id)}/menu`)
      .set(authHeader(admin))
      .send({ date: "2026-10-19", slotId: slots.dinner.id, items: "Rice, dal, chicken curry" });
    expect(posted.status).toBe(200);
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({
      type: "MENU_POSTED",
      title: "Dinner menu for today",
      body: "Rice, dal, chicken curry",
    });

    await request(app)
      .put(`${base(mess.id)}/menu`)
      .set(authHeader(admin))
      .send({ date: "2026-10-19", slotId: slots.dinner.id, items: "Rice, dal, beef curry" });
    await request(app)
      .put(`${base(mess.id)}/menu`)
      .set(authHeader(admin))
      .send({ date: "2026-10-19", slotId: slots.lunch.id, items: "Khichuri" });
    expect(await prisma.notification.count({ where: { userId: user.id } })).toBe(2);

    const list = await request(app)
      .get(`${base(mess.id)}/menu?from=2026-10-19&to=2026-10-19`)
      .set(authHeader(user));
    expect(
      list.body.data.map((m: { slot: { name: string }; items: string }) => [m.slot.name, m.items]),
    ).toEqual([
      ["Lunch", "Khichuri"],
      ["Dinner", "Rice, dal, beef curry"],
    ]);

    const removed = await request(app)
      .delete(`${base(mess.id)}/menu/${posted.body.data.id}`)
      .set(authHeader(admin));
    expect(removed.status).toBe(200);
  });

  it("is managers only", async () => {
    const { user, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/menu`)
      .set(authHeader(user))
      .send({ date: "2026-10-19", slotId: slots.dinner.id, items: "Biryani" });
    expect(res.status).toBe(403);
  });
});
