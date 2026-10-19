import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";
import {
  assertEarlierMonthsClosed,
  assertMonthEditable,
  ensureCurrentMonth,
  monthForDate,
} from "./months.service.js";

const api = (messId: string) => `/api/v1/messes/${messId}/months`;

/** Freezes "now" (only Date is faked, so timers used by the HTTP stack keep working). */
const setNow = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  setNow("2026-10-19T08:00:00Z");
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, month } = await createMess(admin); // October 2026, Oct 1 – Oct 31
  return { admin, mess, october: month };
}

describe("GET /months", () => {
  it("lists months newest first and flags the current one", async () => {
    const { admin, mess, october } = await setup();
    const res = await request(app).get(api(mess.id)).set(authHeader(admin));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      expect.objectContaining({
        id: october.id,
        year: 2026,
        month: 10,
        startDate: "2026-10-01",
        endDate: "2026-10-31",
        status: "OPEN",
        isCurrent: true,
        hasEnded: false,
        manager: null,
      }),
    ]);
  });

  it("opens new months as time passes, without closing the old ones", async () => {
    const { admin, mess } = await setup();
    setNow("2027-01-10T08:00:00Z");

    const res = await request(app).get(api(mess.id)).set(authHeader(admin));
    expect(
      res.body.data.map((m: { startDate: string; status: string; isCurrent: boolean; hasEnded: boolean }) => [
        m.startDate,
        m.status,
        m.isCurrent,
        m.hasEnded,
      ]),
    ).toEqual([
      ["2027-01-01", "OPEN", true, false],
      ["2026-12-01", "OPEN", false, true],
      ["2026-11-01", "OPEN", false, true],
      ["2026-10-01", "OPEN", false, true],
    ]);
  });

  it("uses the mess timezone to decide which day it is", async () => {
    const { admin, mess } = await setup();
    // 20:00 UTC on Oct 31 is already Nov 1 in Dhaka (UTC+6).
    setNow("2026-10-31T20:00:00Z");
    const res = await request(app)
      .get(`${api(mess.id)}/current`)
      .set(authHeader(admin));
    expect(res.body.data).toMatchObject({ year: 2026, month: 11, startDate: "2026-11-01" });
  });

  it("bridges to a new start day without gaps or overlaps", async () => {
    const { admin, mess } = await setup();
    await prisma.mess.update({ where: { id: mess.id }, data: { monthStartDay: 5 } });
    setNow("2026-12-10T08:00:00Z");

    const res = await request(app).get(api(mess.id)).set(authHeader(admin));
    expect(
      res.body.data.map((m: { startDate: string; endDate: string }) => [m.startDate, m.endDate]),
    ).toEqual([
      ["2026-12-05", "2027-01-04"],
      ["2026-11-01", "2026-12-04"],
      ["2026-10-01", "2026-10-31"],
    ]);
  });

  it("is safe to call concurrently", async () => {
    const { mess } = await setup();
    setNow("2027-03-15T08:00:00Z");
    await Promise.all(Array.from({ length: 5 }, () => ensureCurrentMonth(prisma, mess.id)));
    expect(await prisma.messMonth.count({ where: { messId: mess.id } })).toBe(6);
  });

  it("is visible to any member, but not to other messes", async () => {
    const { mess, october } = await setup();
    const member = await createUser();
    await addMember(mess.id, member);
    expect(
      (
        await request(app)
          .get(`${api(mess.id)}/${october.id}`)
          .set(authHeader(member))
      ).status,
    ).toBe(200);

    const { mess: other } = await createMess(await createUser());
    const outsider = await prisma.messMember.findFirstOrThrow({ where: { messId: other.id } });
    const outsiderUser = await prisma.user.findUniqueOrThrow({ where: { id: outsider.userId } });
    // A month id from another mess is not found, even through a mess you belong to.
    expect(
      (
        await request(app)
          .get(`${api(other.id)}/${october.id}`)
          .set(authHeader(outsiderUser))
      ).status,
    ).toBe(404);
  });
});

describe("PATCH /months/:id/manager", () => {
  it("lets an admin assign a month manager, who then gets manager powers", async () => {
    const { admin, mess, october } = await setup();
    const user = await createUser({ name: "Karim" });
    const member = await addMember(mess.id, user);
    const pendingRequests = () =>
      request(app).get(`/api/v1/messes/${mess.id}/members?status=PENDING`).set(authHeader(user));

    expect((await pendingRequests()).status).toBe(403);

    const res = await request(app)
      .patch(`${api(mess.id)}/${october.id}/manager`)
      .set(authHeader(admin))
      .send({ managerId: member.id });
    expect(res.status).toBe(200);
    expect(res.body.data.manager).toMatchObject({ memberId: member.id, name: "Karim" });
    expect(
      await prisma.notification.count({ where: { userId: user.id, title: "You're this month's manager" } }),
    ).toBe(1);

    expect((await pendingRequests()).status).toBe(200);
    const mine = await request(app).get(`/api/v1/messes/${mess.id}`).set(authHeader(user));
    expect(mine.body.data.membership.isMonthManager).toBe(true);

    // Clearing it takes the powers away again.
    await request(app)
      .patch(`${api(mess.id)}/${october.id}/manager`)
      .set(authHeader(admin))
      .send({ managerId: null })
      .expect(200);
    expect((await pendingRequests()).status).toBe(403);
  });

  it("is admin-only and only accepts active members of the mess", async () => {
    const { admin, mess, october } = await setup();
    const managerUser = await createUser();
    await addMember(mess.id, managerUser, { role: "MANAGER" });
    const left = await addMember(mess.id, await createUser(), { status: "LEFT" });
    const url = `${api(mess.id)}/${october.id}/manager`;

    expect(
      (await request(app).patch(url).set(authHeader(managerUser)).send({ managerId: null })).status,
    ).toBe(403);
    expect((await request(app).patch(url).set(authHeader(admin)).send({ managerId: left.id })).status).toBe(
      404,
    );
  });

  it("can't change a closed month", async () => {
    const { admin, mess, october } = await setup();
    await prisma.messMonth.update({ where: { id: october.id }, data: { status: "CLOSED" } });
    const res = await request(app)
      .patch(`${api(mess.id)}/${october.id}/manager`)
      .set(authHeader(admin))
      .send({ managerId: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("MONTH_CLOSED");
  });
});

describe("guards for dated records", () => {
  it("finds the month a date belongs to, and rejects dates outside every month", async () => {
    const { mess, october } = await setup();
    expect((await monthForDate(prisma, mess.id, "2026-10-01")).id).toBe(october.id);
    expect((await monthForDate(prisma, mess.id, "2026-10-26")).id).toBe(october.id);
    // More than a week ahead is rejected, even inside the current month.
    await expect(monthForDate(prisma, mess.id, "2026-10-31")).rejects.toMatchObject({
      code: "DATE_OUTSIDE_MONTHS",
    });
    await expect(monthForDate(prisma, mess.id, "2026-09-30")).rejects.toMatchObject({
      code: "DATE_OUTSIDE_MONTHS",
    });
    await expect(monthForDate(prisma, mess.id, "2026-11-01")).rejects.toMatchObject({
      code: "DATE_OUTSIDE_MONTHS",
    });
  });

  it("only allows changes to OPEN months", () => {
    expect(() => assertMonthEditable({ status: "OPEN" })).not.toThrow();
    expect(() => assertMonthEditable({ status: "CLOSING" })).toThrow(
      expect.objectContaining({ code: "MONTH_CLOSED" }),
    );
    expect(() => assertMonthEditable({ status: "CLOSED" })).toThrow(
      expect.objectContaining({ code: "MONTH_CLOSED" }),
    );
  });

  it("requires months to be closed in order", async () => {
    const { mess, october } = await setup();
    setNow("2026-11-05T08:00:00Z");
    await ensureCurrentMonth(prisma, mess.id);
    const november = await prisma.messMonth.findFirstOrThrow({
      where: { messId: mess.id, startDate: toDbDate("2026-11-01") },
    });

    await expect(assertEarlierMonthsClosed(prisma, november)).rejects.toMatchObject({
      code: "MONTHS_OUT_OF_ORDER",
    });
    await expect(assertEarlierMonthsClosed(prisma, october)).resolves.toBeUndefined();

    await prisma.messMonth.update({ where: { id: october.id }, data: { status: "CLOSED" } });
    await expect(assertEarlierMonthsClosed(prisma, november)).resolves.toBeUndefined();
  });
});

describe("planning ahead", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setNow("2026-10-30T08:00:00Z");
  });

  it("opens next month early for dates up to a week ahead, but no further", async () => {
    const { mess } = await setup();
    const nov2 = await monthForDate(prisma, mess.id, "2026-11-02");
    expect(nov2).toMatchObject({ year: 2026, month: 11 });
    await expect(monthForDate(prisma, mess.id, "2026-11-10")).rejects.toMatchObject({
      code: "DATE_OUTSIDE_MONTHS",
    });
  });
});
