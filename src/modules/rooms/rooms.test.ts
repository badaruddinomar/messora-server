import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, month } = await createMess(admin);
  const user = await createUser({ name: "Tenant" });
  const member = await addMember(mess.id, user);
  return { admin, mess, month, user, member };
}

async function roomWithSeats(messId: string, admin: Parameters<typeof authHeader>[0]) {
  const room = await request(app)
    .post(`${base(messId)}/rooms`)
    .set(authHeader(admin))
    .send({ name: "Room 1", floor: "2nd" });
  const a = await request(app)
    .post(`${base(messId)}/rooms/${room.body.data.id}/seats`)
    .set(authHeader(admin))
    .send({ label: "Bed A", monthlyRent: "3100" });
  const b = await request(app)
    .post(`${base(messId)}/rooms/${room.body.data.id}/seats`)
    .set(authHeader(admin))
    .send({ label: "Bed B", monthlyRent: 2500 });
  return { room: room.body.data, seatA: a.body.data, seatB: b.body.data };
}

describe("rooms and seats", () => {
  it("builds the board and assigns members to seats", async () => {
    const { admin, user, mess, member } = await setup();
    const { seatA, seatB } = await roomWithSeats(mess.id, admin);

    const assign = (seatId: string, memberId: string | null) =>
      request(app)
        .put(`${base(mess.id)}/rooms/seats/${seatId}/member`)
        .set(authHeader(admin))
        .send({ memberId });

    const placed = await assign(seatA.id, member.id);
    expect(placed.body).toMatchObject({
      message: "Tenant is in Bed A",
      data: { member: { name: "Tenant" } },
    });
    expect(
      (await assign(seatA.id, (await prisma.messMember.findFirstOrThrow({ where: { userId: admin.id } })).id))
        .status,
    ).toBe(409);

    // Moving to another seat frees the first.
    await assign(seatB.id, member.id);
    const board = await request(app)
      .get(`${base(mess.id)}/rooms`)
      .set(authHeader(user));
    expect(
      board.body.data.rooms[0].seats.map((s: { label: string; member: { name: string } | null }) => [
        s.label,
        s.member?.name ?? null,
      ]),
    ).toEqual([
      ["Bed A", null],
      ["Bed B", "Tenant"],
    ]);
    expect(board.body.data.summary).toEqual({ seats: 2, occupied: 1, vacant: 1, monthlyRent: "2500.00" });
  });

  it("protects occupied seats and rooms, and is admin only", async () => {
    const { admin, user, mess, member } = await setup();
    const { room, seatA } = await roomWithSeats(mess.id, admin);
    await request(app)
      .put(`${base(mess.id)}/rooms/seats/${seatA.id}/member`)
      .set(authHeader(admin))
      .send({ memberId: member.id });

    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/rooms/seats/${seatA.id}`)
          .set(authHeader(admin))
      ).status,
    ).toBe(409);
    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/rooms/${room.id}`)
          .set(authHeader(admin))
      ).status,
    ).toBe(409);
    const off = await request(app)
      .patch(`${base(mess.id)}/rooms/seats/${seatA.id}`)
      .set(authHeader(admin))
      .send({ isActive: false });
    expect(off.status).toBe(409);
    const dup = await request(app)
      .post(`${base(mess.id)}/rooms`)
      .set(authHeader(admin))
      .send({ name: "Room 1" });
    expect(dup.status).toBe(409);
    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/rooms`)
          .set(authHeader(user))
          .send({ name: "Mine" })
      ).status,
    ).toBe(403);

    const rent = await request(app)
      .patch(`${base(mess.id)}/rooms/seats/${seatA.id}`)
      .set(authHeader(admin))
      .send({ monthlyRent: "3300" });
    expect(rent.body.data.monthlyRent).toBe("3300.00");
    expect(await prisma.auditLog.count({ where: { action: "SEAT_RENT_CHANGED", entityId: seatA.id } })).toBe(
      1,
    );
  });

  it("charges seat rent up to the last day when a member leaves, and frees the seat", async () => {
    const { admin, mess, member, month } = await setup();
    const { seatA } = await roomWithSeats(mess.id, admin);
    await request(app)
      .put(`${base(mess.id)}/rooms/seats/${seatA.id}/member`)
      .set(authHeader(admin))
      .send({ memberId: member.id });

    const res = await request(app)
      .delete(`${base(mess.id)}/members/${member.id}`)
      .set(authHeader(admin))
      .send({});
    expect(res.status).toBe(200);

    const charge = await prisma.memberCharge.findFirstOrThrow({ where: { memberId: member.id } });
    expect(charge).toMatchObject({ monthId: month.id, type: "SEAT_RENT", isProrated: true });
    expect(charge.amount.toFixed(2)).toBe("1000.00"); // 3100 × 10 / 31
    expect((await prisma.messMember.findUniqueOrThrow({ where: { id: member.id } })).seatId).toBeNull();
  });
});

describe("staff", () => {
  it("lets admins manage staff; members see them without phone numbers", async () => {
    const { admin, user, mess } = await setup();
    const created = await request(app)
      .post(`${base(mess.id)}/staff`)
      .set(authHeader(admin))
      .send({ name: "Rahima Khala", phone: "01711000000", role: "COOK", monthlySalary: "6000" });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      name: "Rahima Khala",
      role: "COOK",
      monthlySalary: "6000.00",
      isActive: true,
    });

    const asMember = await request(app)
      .get(`${base(mess.id)}/staff`)
      .set(authHeader(user));
    expect(asMember.body.data[0]).toMatchObject({ name: "Rahima Khala", phone: null, paidThisMonth: false });
    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/staff`)
          .set(authHeader(user))
          .send({ name: "X Y", role: "MAID", monthlySalary: 1 })
      ).status,
    ).toBe(403);

    const raised = await request(app)
      .patch(`${base(mess.id)}/staff/${created.body.data.id}`)
      .set(authHeader(admin))
      .send({ monthlySalary: 6500 });
    expect(raised.body.data.monthlySalary).toBe("6500.00");

    const removed = await request(app)
      .delete(`${base(mess.id)}/staff/${created.body.data.id}`)
      .set(authHeader(admin));
    expect(removed.body.data).toEqual({ deactivated: false });
  });
});
