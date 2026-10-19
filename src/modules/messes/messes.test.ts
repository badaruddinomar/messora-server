import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";
import { slugify } from "./messes.service.js";

const api = "/api/v1/messes";

describe("POST /messes", () => {
  it("creates a ready-to-use mess in one go", async () => {
    const owner = await createUser({ name: "Rahim Uddin" });
    const res = await request(app)
      .post(api)
      .set(authHeader(owner))
      .send({ name: "Green House Mess", address: "Mirpur 10, Dhaka", monthStartDay: 5 });

    expect(res.status).toBe(201);
    const mess = res.body.data;
    expect(mess).toMatchObject({
      name: "Green House Mess",
      slug: "green-house-mess",
      monthStartDay: 5,
      timezone: "Asia/Dhaka",
      activeMemberCount: 1,
      membership: { role: "ADMIN", status: "ACTIVE" },
    });
    expect(mess.joinCode).toMatch(/^[A-Z0-9]{8}$/);

    const [settings, slots, months, conversation] = await Promise.all([
      prisma.messSetting.findUnique({ where: { messId: mess.id } }),
      prisma.mealSlot.findMany({ where: { messId: mess.id }, orderBy: { sortOrder: "asc" } }),
      prisma.messMonth.findMany({ where: { messId: mess.id } }),
      prisma.conversation.findUnique({
        where: { uniqueKey: `group:${mess.id}` },
        include: { participants: true },
      }),
    ]);
    expect(settings).not.toBeNull();
    expect(slots.map((s) => [s.name, s.weight.toString()])).toEqual([
      ["Breakfast", "0.5"],
      ["Lunch", "1"],
      ["Dinner", "1"],
    ]);
    expect(months).toHaveLength(1);
    expect(months[0].status).toBe("OPEN");
    expect(months[0].startDate.getUTCDate()).toBe(5);
    expect(conversation?.participants.map((p) => p.userId)).toEqual([owner.id]);
    expect(await prisma.auditLog.count({ where: { messId: mess.id, action: "MESS_CREATED" } })).toBe(1);
  });

  it("accepts custom meal slots and keeps slugs unique", async () => {
    const owner = await createUser();
    const body = {
      name: "Green House Mess",
      mealSlots: [
        { name: "Lunch", weight: 1 },
        { name: "Dinner", weight: 1 },
      ],
    };
    const first = await request(app).post(api).set(authHeader(owner)).send(body);
    const second = await request(app).post(api).set(authHeader(owner)).send(body);

    expect(second.status).toBe(201);
    expect(second.body.data.slug).toMatch(/^green-house-mess-[a-z0-9]{4}$/);
    expect(second.body.data.slug).not.toBe(first.body.data.slug);
    expect(await prisma.mealSlot.count({ where: { messId: second.body.data.id } })).toBe(2);
  });

  it("validates input", async () => {
    const res = await request(app)
      .post(api)
      .set(authHeader(await createUser()))
      .send({ name: "X", monthStartDay: 31, timezone: "Mars/Olympus" });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.details).sort()).toEqual(["monthStartDay", "name", "timezone"]);
  });

  it("requires login", async () => {
    expect((await request(app).post(api).send({ name: "Green House" })).status).toBe(401);
  });
});

describe("GET /messes", () => {
  it("lists active and pending memberships, but not left or other people's messes", async () => {
    const user = await createUser();
    const { mess: mine } = await createMess(user);
    const { mess: pending } = await createMess(await createUser());
    const { mess: left } = await createMess(await createUser());
    await createMess(await createUser());
    await addMember(pending.id, user, { status: "PENDING" });
    await addMember(left.id, user, { status: "LEFT" });

    const res = await request(app).get(api).set(authHeader(user));
    expect(res.status).toBe(200);
    expect(
      res.body.data.map((m: { id: string; membership: { status: string } }) => [m.id, m.membership.status]),
    ).toEqual([
      [mine.id, "ACTIVE"],
      [pending.id, "PENDING"],
    ]);
    // Join codes are for managers only.
    expect(res.body.data[1].joinCode).toBeNull();
  });
});

describe("updating and deleting", () => {
  it("lets admins update details and settings, but not plain members", async () => {
    const owner = await createUser();
    const { mess } = await createMess(owner);
    const member = await createUser();
    await addMember(mess.id, member);

    const update = await request(app)
      .patch(`${api}/${mess.id}`)
      .set(authHeader(owner))
      .send({ name: "Blue House" });
    expect(update.status).toBe(200);
    expect(update.body.data.name).toBe("Blue House");

    const settings = await request(app)
      .patch(`${api}/${mess.id}/settings`)
      .set(authHeader(owner))
      .send({ requireBazarApproval: false });
    expect(settings.body.data.requireBazarApproval).toBe(false);

    expect(
      (await request(app).patch(`${api}/${mess.id}`).set(authHeader(member)).send({ name: "Mine" })).status,
    ).toBe(403);
    expect((await request(app).get(`${api}/${mess.id}/settings`).set(authHeader(member))).status).toBe(200);
  });

  it("deletes a mess only when the admin types its name", async () => {
    const owner = await createUser();
    const { mess } = await createMess(owner, { name: "Green House" });

    const wrong = await request(app)
      .delete(`${api}/${mess.id}`)
      .set(authHeader(owner))
      .send({ confirmName: "nope" });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe("CONFIRMATION_MISMATCH");

    const ok = await request(app)
      .delete(`${api}/${mess.id}`)
      .set(authHeader(owner))
      .send({ confirmName: "green house" });
    expect(ok.status).toBe(200);
    expect((await request(app).get(`${api}/${mess.id}`).set(authHeader(owner))).status).toBe(404);
    expect((await request(app).get(api).set(authHeader(owner))).body.data).toEqual([]);
  });

  it("regenerates the join code (managers only)", async () => {
    const owner = await createUser();
    const { mess } = await createMess(owner);
    const res = await request(app).post(`${api}/${mess.id}/join-code`).set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.data.joinCode).not.toBe(mess.joinCode);
  });
});

describe("slugify", () => {
  it.each([
    ["Green House Mess", "green-house-mess"],
    ["  Rahim's   Mess!! ", "rahim-s-mess"],
    ["সবুজ মেস", "mess"],
    ["Café Ünïon", "cafe-union"],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
