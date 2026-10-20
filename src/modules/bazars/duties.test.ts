import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { runBazarDutyReminders } from "../../jobs/bazar-duty-reminder.job.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}/bazar-duties`;

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
  const aUser = await createUser({ name: "Asif" });
  const bUser = await createUser({ name: "Bilal" });
  const a = await addMember(mess.id, aUser);
  const b = await addMember(mess.id, bUser);
  return { admin, adminMember: ownerMember, mess, month, aUser, bUser, a, b };
}

type Duty = { id: string; date: string; isDone: boolean; member: { id: string; name: string } };
const plan = (duties: Duty[]) => duties.map((d) => `${d.date.slice(8)} ${d.member.name}`);

describe("generating a rotation", () => {
  it("takes turns from today to the month's end, every N days, and tells each member", async () => {
    const { admin, mess, a, b, aUser } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/generate`)
      .set(authHeader(admin))
      .send({ memberIds: [a.id, b.id], everyDays: 3 });

    expect(res.status).toBe(200);
    expect(plan(res.body.data.duties)).toEqual(["19 Asif", "22 Bilal", "25 Asif", "28 Bilal", "31 Asif"]);
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: aUser.id } })).toMatchObject({
      type: "BAZAR_DUTY_REMINDER",
      title: "Your bazar days for October 2026",
      body: "2026-10-19, 2026-10-25, 2026-10-31",
    });
  });

  it("puts several members on a day, skips people who haven't joined yet, and keeps done duties", async () => {
    const { admin, mess, month, a, b, adminMember } = await setup();
    const late = await addMember(mess.id, await createUser({ name: "Late" }), { joinedAt: "2026-10-30" });
    await prisma.bazarSchedule.create({
      data: {
        messId: mess.id,
        monthId: month.id,
        memberId: adminMember.id,
        date: toDbDate("2026-10-19"),
        isDone: true,
      },
    });
    const old = await prisma.bazarSchedule.create({
      data: { messId: mess.id, monthId: month.id, memberId: a.id, date: toDbDate("2026-10-20") },
    });

    const res = await request(app)
      .post(`${base(mess.id)}/generate`)
      .set(authHeader(admin))
      .send({ memberIds: [late.id, a.id, b.id], everyDays: 4, perDay: 2, fromDate: "2026-10-23" });

    expect(plan(res.body.data.duties)).toEqual([
      "19 Admin", // done before the plan: kept
      "20 Asif", // before fromDate: kept
      "23 Asif",
      "23 Bilal",
      "27 Asif",
      "27 Bilal",
      "31 Asif",
      "31 Late",
    ]);
    expect(await prisma.bazarSchedule.findUnique({ where: { id: old.id } })).not.toBeNull();
  });

  it("is managers only", async () => {
    const { aUser, mess, a } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/generate`)
      .set(authHeader(aUser))
      .send({ memberIds: [a.id] });
    expect(res.status).toBe(403);
  });
});

describe("single duties", () => {
  it("adds, moves, swaps and removes duties", async () => {
    const { admin, mess, a, b, bUser } = await setup();
    const add = (date: string, memberId: string) =>
      request(app).post(base(mess.id)).set(authHeader(admin)).send({ date, memberId });

    const one = await add("2026-10-21", a.id);
    const two = await add("2026-10-24", b.id);
    expect(one.status).toBe(201);
    expect((await add("2026-10-21", a.id)).status).toBe(409);

    const swapped = await request(app)
      .post(`${base(mess.id)}/swap`)
      .set(authHeader(admin))
      .send({ dutyId: one.body.data.id, otherDutyId: two.body.data.id });
    expect(swapped.body.data.map((d: Duty) => `${d.date} ${d.member.name}`)).toEqual([
      "2026-10-21 Bilal",
      "2026-10-24 Asif",
    ]);
    expect(
      await prisma.notification.count({ where: { userId: bUser.id, title: "Bazar duty swapped" } }),
    ).toBe(1);

    const moved = await request(app)
      .patch(`${base(mess.id)}/${one.body.data.id}`)
      .set(authHeader(admin))
      .send({ date: "2026-10-22" });
    expect(moved.body.data).toMatchObject({ date: "2026-10-22", member: { name: "Bilal" } });

    const removed = await request(app)
      .delete(`${base(mess.id)}/${one.body.data.id}`)
      .set(authHeader(admin));
    expect(removed.status).toBe(200);
    const list = await request(app).get(base(mess.id)).set(authHeader(admin));
    expect(plan(list.body.data.duties)).toEqual(["24 Asif"]);
  });

  it("lets members tick off only their own duty, and not reassign it", async () => {
    const { admin, mess, a, b, aUser } = await setup();
    const mine = await request(app)
      .post(base(mess.id))
      .set(authHeader(admin))
      .send({ date: "2026-10-19", memberId: a.id });
    const theirs = await request(app)
      .post(base(mess.id))
      .set(authHeader(admin))
      .send({ date: "2026-10-19", memberId: b.id });

    const done = await request(app)
      .patch(`${base(mess.id)}/${mine.body.data.id}`)
      .set(authHeader(aUser))
      .send({ isDone: true });
    expect(done.body.data.isDone).toBe(true);

    const notMine = await request(app)
      .patch(`${base(mess.id)}/${theirs.body.data.id}`)
      .set(authHeader(aUser))
      .send({ isDone: true });
    expect(notMine.status).toBe(403);

    const reassign = await request(app)
      .patch(`${base(mess.id)}/${mine.body.data.id}`)
      .set(authHeader(aUser))
      .send({ memberId: b.id });
    expect(reassign.status).toBe(403);
  });
});

describe("runBazarDutyReminders", () => {
  it("reminds today's undone duties once, from 8 AM in the mess timezone", async () => {
    const { mess, month, a, b, aUser, bUser } = await setup();
    for (const [memberId, isDone] of [
      [a.id, false],
      [b.id, true],
    ] as const) {
      await prisma.bazarSchedule.create({
        data: { messId: mess.id, monthId: month.id, memberId, date: toDbDate("2026-10-20"), isDone },
      });
    }

    vi.setSystemTime(new Date("2026-10-20T01:30:00Z")); // 07:30 in Dhaka
    expect((await runBazarDutyReminders()).sent).toBe(0);

    vi.setSystemTime(new Date("2026-10-20T02:10:00Z")); // 08:10 in Dhaka
    expect((await runBazarDutyReminders()).sent).toBe(1);
    expect((await runBazarDutyReminders()).sent).toBe(0);

    expect(await prisma.notification.count({ where: { userId: aUser.id, title: "Bazar duty today" } })).toBe(
      1,
    );
    expect(await prisma.notification.count({ where: { userId: bUser.id } })).toBe(0);
  });
});
