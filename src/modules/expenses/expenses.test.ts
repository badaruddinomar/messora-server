import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createSlots, createUser } from "../../test/factories.js";
import { toDbDate } from "../../utils/date.js";

const base = (messId: string) => `/api/v1/messes/${messId}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T08:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

/** Admin + two members; automatic meals off so each test sets meals itself. */
async function setup() {
  const admin = await createUser({ name: "Admin" });
  const { mess, ownerMember, month } = await createMess(admin);
  await prisma.messSetting.update({ where: { messId: mess.id }, data: { autoGenerateMeals: false } });
  const bUser = await createUser({ name: "Bina" });
  const cUser = await createUser({ name: "Chhoton" });
  const b = await addMember(mess.id, bUser);
  const c = await addMember(mess.id, cUser);
  return { admin, a: ownerMember, mess, month, bUser, cUser, b, c };
}

const expense = (overrides: object = {}) => ({
  category: "ELECTRICITY",
  title: "Electricity bill",
  amount: "1000",
  billDate: "2026-10-08",
  ...overrides,
});

describe("POST /expenses", () => {
  it("splits equally to the paisa, and tells everyone", async () => {
    const { admin, bUser, mess } = await setup();
    const res = await request(app)
      .post(`${base(mess.id)}/expenses`)
      .set(authHeader(admin))
      .send(expense());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      amount: "1000.00",
      splitType: "EQUAL",
      paidFrom: "MESS_FUND",
      canEdit: true,
    });

    const detail = await request(app)
      .get(`${base(mess.id)}/expenses/${res.body.data.id}`)
      .set(authHeader(bUser));
    const shares = detail.body.data.shares.map((s: { amount: string }) => s.amount);
    expect([...shares].sort()).toEqual(["333.33", "333.33", "333.34"]);
    expect(detail.body.data.canEdit).toBe(false);
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: bUser.id } })).toMatchObject({
      type: "EXPENSE_ADDED",
      title: "Electricity bill: ৳1000.00",
    });
  });

  it("splits by meals, and falls back to equal when nobody ate", async () => {
    const { admin, a, b, mess, month } = await setup();
    const { lunch } = await createSlots(mess.id);
    const preview = (splitType: string) =>
      request(app)
        .post(`${base(mess.id)}/expenses/split-preview`)
        .set(authHeader(admin))
        .send({ billDate: "2026-10-08", amount: "900", splitType });

    const empty = await preview("BY_MEAL");
    expect(empty.body.data.fellBackToEqual).toBe(true);
    expect(empty.body.data.shares.map((s: { amount: string }) => s.amount)).toEqual([
      "300.00",
      "300.00",
      "300.00",
    ]);

    // Admin 2 meals, Bina 1 meal, Chhoton none.
    await prisma.mealEntry.createMany({
      data: [
        {
          messId: mess.id,
          monthId: month.id,
          memberId: a.id,
          slotId: lunch.id,
          date: toDbDate("2026-10-01"),
          quantity: 1,
        },
        {
          messId: mess.id,
          monthId: month.id,
          memberId: a.id,
          slotId: lunch.id,
          date: toDbDate("2026-10-02"),
          quantity: 1,
        },
        {
          messId: mess.id,
          monthId: month.id,
          memberId: b.id,
          slotId: lunch.id,
          date: toDbDate("2026-10-01"),
          quantity: 1,
        },
      ],
    });
    const byMeal = await preview("BY_MEAL");
    expect(
      byMeal.body.data.shares.map((s: { member: { name: string }; amount: string }) => [
        s.member.name,
        s.amount,
      ]),
    ).toEqual([
      ["Admin", "600.00"],
      ["Bina", "300.00"],
      ["Chhoton", "0.00"],
    ]);
  });

  it("checks custom shares add up exactly", async () => {
    const { admin, a, b, c, mess } = await setup();
    const shares = (amounts: string[]) => [a, b, c].map((m, i) => ({ memberId: m.id, amount: amounts[i] }));
    const post = (body: object) =>
      request(app)
        .post(`${base(mess.id)}/expenses`)
        .set(authHeader(admin))
        .send(body);

    const off = await post(expense({ splitType: "CUSTOM", shares: shares(["500", "300", "100"]) }));
    expect(off.status).toBe(422);
    expect(off.body.code).toBe("SHARES_MISMATCH");
    expect((await post(expense({ splitType: "CUSTOM" }))).status).toBe(400);

    const ok = await post(expense({ splitType: "CUSTOM", shares: shares(["500", "300", "200"]) }));
    expect(ok.status).toBe(201);
    const detail = await request(app)
      .get(`${base(mess.id)}/expenses/${ok.body.data.id}`)
      .set(authHeader(admin));
    expect(detail.body.data.shares.map((s: { amount: string }) => s.amount)).toEqual([
      "500.00",
      "300.00",
      "200.00",
    ]);

    // Changing the amount without new shares no longer adds up.
    const edit = await request(app)
      .patch(`${base(mess.id)}/expenses/${ok.body.data.id}`)
      .set(authHeader(admin))
      .send({ amount: "1200" });
    expect(edit.body.code).toBe("SHARES_MISMATCH");
  });

  it("is for managers, needs a payer for own-pocket costs, and respects closed months", async () => {
    const { admin, bUser, mess, month } = await setup();
    expect(
      (
        await request(app)
          .post(`${base(mess.id)}/expenses`)
          .set(authHeader(bUser))
          .send(expense())
      ).status,
    ).toBe(403);
    const noPayer = await request(app)
      .post(`${base(mess.id)}/expenses`)
      .set(authHeader(admin))
      .send(expense({ paidFrom: "OWN_POCKET" }));
    expect(noPayer.status).toBe(400);
    await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
    const closed = await request(app)
      .post(`${base(mess.id)}/expenses`)
      .set(authHeader(admin))
      .send(expense());
    expect(closed.body.code).toBe("MONTH_CLOSED");
  });
});

describe("pay staff", () => {
  it("records the salary as a shared expense, once a month unless asked again", async () => {
    const { admin, mess } = await setup();
    const staff = await prisma.messStaff.create({
      data: { messId: mess.id, name: "Rahima", role: "COOK", monthlySalary: 6000 },
    });
    const pay = (body: object = {}) =>
      request(app)
        .post(`${base(mess.id)}/expenses/pay-staff`)
        .set(authHeader(admin))
        .send({ staffId: staff.id, billDate: "2026-10-10", ...body });

    const first = await pay();
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      category: "COOK_SALARY",
      title: "Rahima's salary",
      amount: "6000.00",
      staff: { id: staff.id, name: "Rahima" },
    });
    const twice = await pay();
    expect(twice.body.code).toBe("SALARY_ALREADY_PAID");
    expect((await pay({ again: true, amount: "1000" })).status).toBe(201);

    const list = await request(app)
      .get(`${base(mess.id)}/staff?monthId=${first.body.data.monthId}`)
      .set(authHeader(admin));
    expect(list.body.data[0]).toMatchObject({ paidThisMonth: true, paidAmount: "7000.00" });
  });
});

describe("summary and the month's bill", () => {
  it("groups by category and feeds shared costs, own-pocket credit, charges and seat rent into balances", async () => {
    const { admin, a, b, c, bUser, mess, month } = await setup();
    const post = (body: object) =>
      request(app)
        .post(`${base(mess.id)}/expenses`)
        .set(authHeader(admin))
        .send(body);
    await post(expense({ amount: "900" }));
    await post(
      expense({
        category: "INTERNET",
        title: "Wi-Fi",
        amount: "600",
        paidFrom: "OWN_POCKET",
        paidByMemberId: b.id,
      }),
    );

    const summary = await request(app)
      .get(`${base(mess.id)}/expenses/summary`)
      .set(authHeader(bUser));
    expect(summary.body.data).toMatchObject({
      total: "1500.00",
      count: 2,
      yourShare: "500.00",
      byPaidFrom: { MESS_FUND: "900.00", OWN_POCKET: "600.00" },
      byCategory: [
        { category: "ELECTRICITY", total: "900.00" },
        { category: "INTERNET", total: "600.00" },
      ],
    });

    // A fine for Chhoton, a discount for Bina, and a seat for the admin.
    await request(app)
      .post(`${base(mess.id)}/charges`)
      .set(authHeader(admin))
      .send({ memberId: c.id, type: "FINE", amount: "50", description: "Late payment" });
    await request(app)
      .post(`${base(mess.id)}/charges`)
      .set(authHeader(admin))
      .send({ memberId: b.id, type: "ADJUSTMENT", amount: "-100", description: "Fixed the tap" });
    const room = await prisma.room.create({ data: { messId: mess.id, name: "Room 1" } });
    const seat = await prisma.seat.create({
      data: { messId: mess.id, roomId: room.id, label: "A", monthlyRent: 3000 },
    });
    await prisma.messMember.update({ where: { id: a.id }, data: { seatId: seat.id } });

    const preview = await request(app)
      .get(`${base(mess.id)}/months/${month.id}/preview`)
      .set(authHeader(admin));
    expect(preview.body.data.totals.totalExpenses).toBe("1500.00");
    expect(preview.body.data.cash).toMatchObject({ messFundExpenses: "900.00", closingCash: "-900.00" });
    const row = (name: string) =>
      preview.body.data.members.find((m: { member: { name: string } }) => m.member.name === name);
    expect(row("Admin")).toMatchObject({
      sharedCost: "500.00",
      chargeTotal: "3000.00",
      seatRentEstimate: "3000.00",
      closingBalance: "-3500.00",
    });
    expect(row("Bina")).toMatchObject({
      sharedCost: "500.00",
      chargeTotal: "-100.00",
      ownPocketExpenses: "600.00",
      totalDeposit: "600.00",
      closingBalance: "200.00",
    });
    expect(row("Chhoton")).toMatchObject({ chargeTotal: "50.00", closingBalance: "-550.00" });
  });
});

describe("charges", () => {
  it("lets managers add, edit and remove charges; members see their own", async () => {
    const { admin, b, bUser, c, mess } = await setup();
    const post = (body: object, as = admin) =>
      request(app)
        .post(`${base(mess.id)}/charges`)
        .set(authHeader(as))
        .send(body);

    const fine = await post({ memberId: b.id, type: "FINE", amount: "50", description: "Broke a plate" });
    expect(fine.status).toBe(201);
    expect((await post({ memberId: b.id, type: "FINE", amount: "-50", description: "x y" })).status).toBe(
      400,
    );
    expect((await post({ memberId: b.id, type: "SEAT_RENT", amount: "50", description: "x y" })).status).toBe(
      400,
    );
    expect(
      (await post({ memberId: b.id, type: "FINE", amount: "50", description: "x y" }, bUser)).status,
    ).toBe(403);
    await post({ memberId: c.id, type: "PERSONAL", amount: "120", description: "Extra milk" });

    const mine = await request(app)
      .get(`${base(mess.id)}/charges`)
      .set(authHeader(bUser));
    expect(mine.body.data).toMatchObject({
      total: "50.00",
      items: [{ type: "FINE", amount: "50.00", canEdit: false }],
    });
    expect(await prisma.notification.findFirstOrThrow({ where: { userId: bUser.id } })).toMatchObject({
      type: "CHARGE_ADDED",
      title: "Fine: ৳50.00",
    });

    const edited = await request(app)
      .patch(`${base(mess.id)}/charges/${fine.body.data.id}`)
      .set(authHeader(admin))
      .send({ amount: "30" });
    expect(edited.body.data.amount).toBe("30.00");
    expect(
      (
        await request(app)
          .delete(`${base(mess.id)}/charges/${fine.body.data.id}`)
          .set(authHeader(admin))
      ).status,
    ).toBe(200);
    const all = await request(app)
      .get(`${base(mess.id)}/charges`)
      .set(authHeader(admin));
    expect(all.body.data.items).toHaveLength(1);
  });
});
