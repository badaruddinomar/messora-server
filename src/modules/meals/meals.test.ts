import { MessRole } from "@prisma/client";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createSlots, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";
import { generateMealEntries } from "./meals.generation.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 14:00 in Dhaka: breakfast (07:00) and lunch (10:00) are past their cutoff, dinner (17:00) isn't.
  setNow("2026-10-19T08:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, ownerMember, month } = await createMess(admin);
  const slots = await createSlots(mess.id);
  const user = await createUser({ name: "Member" });
  const member = await addMember(mess.id, user);
  return { admin, adminMember: ownerMember, mess, month, slots, user, member };
}

const entry = (memberId: string, slotId: string, date: string, quantity: number, guestQuantity = 0) => ({
  memberId,
  slotId,
  date,
  quantity,
  guestQuantity,
});

describe("meal generation", () => {
  it("creates usual meals once, respecting preferences and off periods", async () => {
    const { mess, slots, member, adminMember } = await setup();
    await prisma.messMember.update({ where: { id: adminMember.id }, data: { defaultMealOn: false } });
    await prisma.mealOffPeriod.create({
      data: {
        messId: mess.id,
        memberId: member.id,
        fromDate: toDbDate("2026-10-21"),
        toDate: toDbDate("2026-10-21"),
      },
    });

    const created = await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-21");
    expect(created).toBe(2 * 2 * 3);
    expect(await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-21")).toBe(0);

    const quantity = async (memberId: string, date: string) =>
      (
        await prisma.mealEntry.findUniqueOrThrow({
          where: { memberId_slotId_date: { memberId, slotId: slots.lunch.id, date: toDbDate(date) } },
        })
      ).quantity.toNumber();
    expect(await quantity(member.id, "2026-10-20")).toBe(1);
    expect(await quantity(member.id, "2026-10-21")).toBe(0);
    expect(await quantity(adminMember.id, "2026-10-20")).toBe(0);
  });

  it("does nothing when automatic meals are off, and never touches closed months", async () => {
    const { mess, month } = await setup();
    await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: false } });
    expect(await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-20")).toBe(0);

    await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: true } });
    await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
    expect(await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-20")).toBe(0);
  });

  it("skips days before a member joined", async () => {
    const { mess } = await setup();
    const late = await addMember(mess.id, await createUser(), { joinedAt: "2026-10-21" });
    await generateMealEntries(prisma, mess.id, "2026-10-20", "2026-10-21");
    const dates = await prisma.mealEntry.findMany({ where: { memberId: late.id }, select: { date: true } });
    expect(new Set(dates.map((d) => d.date.toISOString().slice(0, 10)))).toEqual(new Set(["2026-10-21"]));
  });
});

describe("GET /meals/day", () => {
  it("returns the day sheet with cutoffs, rows and weighted totals", async () => {
    const { admin, mess, slots } = await setup();
    const res = await request(app)
      .get(`${base(mess.id)}/meals/day?date=2026-10-19`)
      .set(authHeader(admin));

    expect(res.status).toBe(200);
    const day = res.body.data;
    expect(day).toMatchObject({
      date: "2026-10-19",
      editable: true,
      canEditOthers: true,
      allowGuestMeal: true,
    });
    expect(day.slots.map((s: { name: string; isPastCutoff: boolean }) => [s.name, s.isPastCutoff])).toEqual([
      ["Breakfast", true],
      ["Lunch", true],
      ["Dinner", false],
    ]);
    expect(day.slots[2].cutoffAt).toBe("2026-10-19T11:00:00.000Z");
    expect(day.you).toEqual({ memberId: expect.any(String), defaultMealOn: true });
    expect(day.slots[0].menu).toBeNull();
    expect(day.rows).toHaveLength(2);
    expect(day.rows[0].weightedMeals).toBe("2.5");
    expect(day.totals[slots.lunch.id]).toEqual({ meals: "2", guests: "0" });
    expect(day.weightedTotal).toBe("5");
  });

  it("tells a member what they can still change", async () => {
    const { user, mess } = await setup();
    const res = await request(app)
      .get(`${base(mess.id)}/meals/day?date=2026-10-19`)
      .set(authHeader(user));
    expect(res.body.data.canEditOthers).toBe(false);
    expect(res.body.data.slots.map((s: { canEditOwn: boolean }) => s.canEditOwn)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("rejects dates beyond the planning window and bad input", async () => {
    const { admin, mess } = await setup();
    const far = await request(app)
      .get(`${base(mess.id)}/meals/day?date=2026-11-30`)
      .set(authHeader(admin));
    expect(far.status).toBe(422);
    expect(far.body.code).toBe("DATE_OUTSIDE_MONTHS");

    const bad = await request(app)
      .get(`${base(mess.id)}/meals/day?date=yesterday`)
      .set(authHeader(admin));
    expect(bad.status).toBe(400);
  });

  it("keeps other messes out", async () => {
    const { mess } = await setup();
    const outsider = await createUser();
    const res = await request(app)
      .get(`${base(mess.id)}/meals/day?date=2026-10-19`)
      .set(authHeader(outsider));
    expect(res.status).toBe(404);
  });
});

describe("GET /meals/members/:memberId", () => {
  it("returns my calendar and totals", async () => {
    const { user, mess } = await setup();
    const res = await request(app)
      .get(`${base(mess.id)}/meals/members/me?from=2026-10-19&to=2026-10-20`)
      .set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(2);
    expect(res.body.data.totals).toEqual({ weightedMeals: "5", meals: "6", guestMeals: "0" });
  });

  it("only managers see other members' calendars", async () => {
    const { user, adminMember, admin, member, mess } = await setup();
    const range = "from=2026-10-19&to=2026-10-19";
    const denied = await request(app)
      .get(`${base(mess.id)}/meals/members/${adminMember.id}?${range}`)
      .set(authHeader(user));
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .get(`${base(mess.id)}/meals/members/${member.id}?${range}`)
      .set(authHeader(admin));
    expect(allowed.status).toBe(200);
  });
});

describe("PUT /meals", () => {
  it("lets members change their own meals before the cutoff", async () => {
    const { user, member, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({
        entries: [
          entry(member.id, slots.dinner.id, "2026-10-19", 0),
          entry(member.id, slots.lunch.id, "2026-10-20", 1.5, 1),
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slotId: slots.dinner.id, date: "2026-10-19", quantity: "0" }),
        expect.objectContaining({
          slotId: slots.lunch.id,
          date: "2026-10-20",
          quantity: "1.5",
          guestQuantity: "1",
        }),
      ]),
    );
    expect(await prisma.auditLog.count({ where: { messId: mess.id, action: "MEALS_UPDATED" } })).toBe(0);
  });

  it("stops members after the cutoff, in the mess timezone", async () => {
    const { user, member, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({ entries: [entry(member.id, slots.lunch.id, "2026-10-19", 0)] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MEAL_CUTOFF_PASSED");
  });

  it("is all-or-nothing", async () => {
    const { user, member, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({
        entries: [
          entry(member.id, slots.dinner.id, "2026-10-19", 2),
          entry(member.id, slots.lunch.id, "2026-10-19", 0),
        ],
      });
    expect(res.status).toBe(422);
    const dinner = await prisma.mealEntry.findUnique({
      where: {
        memberId_slotId_date: { memberId: member.id, slotId: slots.dinner.id, date: toDbDate("2026-10-19") },
      },
    });
    expect(dinner?.quantity.toNumber() ?? 1).toBe(1);
  });

  it("stops members from changing other people's meals", async () => {
    const { user, adminMember, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({ entries: [entry(adminMember.id, slots.dinner.id, "2026-10-19", 0)] });
    expect(res.status).toBe(403);
  });

  it("follows the mess settings for member edits and guests", async () => {
    const { user, member, mess, slots } = await setup();
    await prisma.messSetting.update({ where: { messId: mess.id }, data: { allowGuestMeal: false } });
    const guests = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({ entries: [entry(member.id, slots.dinner.id, "2026-10-19", 1, 1)] });
    expect(guests.body.code).toBe("GUEST_MEALS_DISABLED");

    await prisma.messSetting.update({ where: { messId: mess.id }, data: { allowMemberMealEdit: false } });
    const edits = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({ entries: [entry(member.id, slots.dinner.id, "2026-10-19", 0)] });
    expect(edits.status).toBe(403);
    expect(edits.body.code).toBe("MEAL_EDITING_DISABLED");
  });

  it("lets managers change anyone's meals after the cutoff, and tells them", async () => {
    const { admin, user, member, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(admin))
      .send({ entries: [entry(member.id, slots.breakfast.id, "2026-10-18", 2)] });

    expect(res.status).toBe(200);
    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: user.id } });
    expect(notification).toMatchObject({
      type: "MEAL_UPDATED_BY_MANAGER",
      body: "Admin changed your meals for 2026-10-18",
    });
    expect(await prisma.auditLog.count({ where: { messId: mess.id, action: "MEALS_UPDATED" } })).toBe(1);
  });

  it("gives the month manager manager powers", async () => {
    const { mess, month, slots, adminMember } = await setup();
    const mmUser = await createUser();
    const mm = await addMember(mess.id, mmUser, { role: MessRole.MEMBER });
    await prisma.messMonth.update({ where: { id: month.id }, data: { managerId: mm.id } });
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(mmUser))
      .send({ entries: [entry(adminMember.id, slots.lunch.id, "2026-10-19", 0)] });
    expect(res.status).toBe(200);
  });

  it("rejects closed months, days before joining, and other messes' slots", async () => {
    const { admin, member, mess, month, slots } = await setup();
    const late = await addMember(mess.id, await createUser(), { joinedAt: "2026-10-15" });
    const beforeJoin = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(admin))
      .send({ entries: [entry(late.id, slots.lunch.id, "2026-10-10", 1)] });
    expect(beforeJoin.body.code).toBe("MEMBER_NOT_ACTIVE_ON_DATE");

    const other = await createMess(admin);
    const otherSlots = await createSlots(other.mess.id);
    const foreign = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(admin))
      .send({ entries: [entry(member.id, otherSlots.lunch.id, "2026-10-19", 1)] });
    expect(foreign.status).toBe(404);

    await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
    const closed = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(admin))
      .send({ entries: [entry(member.id, slots.lunch.id, "2026-10-19", 1)] });
    expect(closed.body.code).toBe("MONTH_CLOSED");
  });

  it("validates quantities", async () => {
    const { user, member, mess, slots } = await setup();
    const res = await request(app)
      .put(`${base(mess.id)}/meals`)
      .set(authHeader(user))
      .send({ entries: [entry(member.id, slots.dinner.id, "2026-10-19", 0.3)] });
    expect(res.status).toBe(400);
  });
});

describe("meal slots", () => {
  it("lets admins add, rename and remove meals", async () => {
    const { admin, mess, slots } = await setup();
    const created = await request(app)
      .post(`${base(mess.id)}/meal-slots`)
      .set(authHeader(admin))
      .send({ name: "Snacks", weight: 0.25, cutoffTime: "15:00" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ name: "Snacks", weight: "0.25", sortOrder: 3, isActive: true });

    const dup = await request(app)
      .post(`${base(mess.id)}/meal-slots`)
      .set(authHeader(admin))
      .send({ name: "Lunch", weight: 1 });
    expect(dup.status).toBe(409);

    const renamed = await request(app)
      .patch(`${base(mess.id)}/meal-slots/${slots.dinner.id}`)
      .set(authHeader(admin))
      .send({ name: "Supper" });
    expect(renamed.body.data.name).toBe("Supper");

    const removed = await request(app)
      .delete(`${base(mess.id)}/meal-slots/${created.body.data.id}`)
      .set(authHeader(admin));
    expect(removed.body.data).toEqual({ archived: false });

    const list = await request(app)
      .get(`${base(mess.id)}/meal-slots`)
      .set(authHeader(admin));
    expect(list.body.data.map((s: { name: string }) => s.name)).toEqual(["Breakfast", "Lunch", "Supper"]);
  });

  it("archives meals that were eaten and drops their upcoming entries", async () => {
    const { admin, mess, slots } = await setup();
    await generateMealEntries(prisma, mess.id, "2026-10-18", "2026-10-21");
    const res = await request(app)
      .delete(`${base(mess.id)}/meal-slots/${slots.breakfast.id}`)
      .set(authHeader(admin));
    expect(res.body.data).toEqual({ archived: true });

    const left = await prisma.mealEntry.findMany({
      where: { slotId: slots.breakfast.id },
      select: { date: true },
    });
    expect(new Set(left.map((e) => e.date.toISOString().slice(0, 10)))).toEqual(
      new Set(["2026-10-18", "2026-10-19"]),
    );
  });

  it("keeps at least one meal and admin-only writes", async () => {
    const { admin, user, mess, slots } = await setup();
    const denied = await request(app)
      .post(`${base(mess.id)}/meal-slots`)
      .set(authHeader(user))
      .send({ name: "Tea", weight: 0.25 });
    expect(denied.status).toBe(403);

    await request(app)
      .delete(`${base(mess.id)}/meal-slots/${slots.breakfast.id}`)
      .set(authHeader(admin));
    await request(app)
      .delete(`${base(mess.id)}/meal-slots/${slots.lunch.id}`)
      .set(authHeader(admin));
    const last = await request(app)
      .delete(`${base(mess.id)}/meal-slots/${slots.dinner.id}`)
      .set(authHeader(admin));
    expect(last.status).toBe(422);
  });
});
