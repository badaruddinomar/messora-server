import request from "supertest";
import { describe, expect, it } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";

const api = "/api/v1/messes";

async function messWithPeople() {
  const admin = await createUser({ name: "Admin" });
  const { mess } = await createMess(admin);
  await prisma.conversation.create({
    data: { messId: mess.id, type: "MESS_GROUP", uniqueKey: `group:${mess.id}`, title: mess.name },
  });
  const managerUser = await createUser({ name: "Manager" });
  const memberUser = await createUser({ name: "Member" });
  const manager = await addMember(mess.id, managerUser, { role: "MANAGER" });
  const member = await addMember(mess.id, memberUser);
  return { mess, admin, managerUser, memberUser, manager, member };
}

describe("joining with a code", () => {
  it("creates a pending request, notifies managers, and can be approved", async () => {
    const { mess, admin, managerUser } = await messWithPeople();
    const joiner = await createUser({ name: "Karim" });

    const join = await request(app)
      .post(`${api}/join`)
      .set(authHeader(joiner))
      .send({ joinCode: mess.joinCode.toLowerCase() });
    expect(join.status).toBe(201);
    expect(join.body.data.membership.status).toBe("PENDING");
    expect(join.body.data.joinCode).toBeNull();

    const notified = await prisma.notification.findMany({ where: { type: "JOIN_REQUEST" } });
    expect(notified.map((n) => n.userId).sort()).toEqual([admin.id, managerUser.id].sort());

    // Pending members can't use the mess yet.
    expect((await request(app).get(`${api}/${mess.id}`).set(authHeader(joiner))).status).toBe(403);

    const pending = await request(app)
      .get(`${api}/${mess.id}/members?status=PENDING`)
      .set(authHeader(managerUser));
    expect(pending.body.data.map((m: { user: { name: string } }) => m.user.name)).toEqual(["Karim"]);

    const approve = await request(app)
      .post(`${api}/${mess.id}/members/${pending.body.data[0].id}/approve`)
      .set(authHeader(managerUser));
    expect(approve.status).toBe(200);
    expect(approve.body.data).toMatchObject({ status: "ACTIVE", joinedAt: expect.any(String) });

    expect((await request(app).get(`${api}/${mess.id}`).set(authHeader(joiner))).status).toBe(200);
    expect(await prisma.notification.count({ where: { userId: joiner.id, type: "JOIN_APPROVED" } })).toBe(1);
    const participant = await prisma.conversationParticipant.findFirst({ where: { userId: joiner.id } });
    expect(participant?.leftAt).toBeNull();
  });

  it("rejects bad codes and duplicate requests", async () => {
    const { mess, memberUser } = await messWithPeople();
    const joiner = await createUser();

    const bad = await request(app).post(`${api}/join`).set(authHeader(joiner)).send({ joinCode: "ZZZZZZZZ" });
    expect(bad.status).toBe(404);
    expect(bad.body.code).toBe("INVALID_JOIN_CODE");

    await request(app).post(`${api}/join`).set(authHeader(joiner)).send({ joinCode: mess.joinCode });
    const again = await request(app)
      .post(`${api}/join`)
      .set(authHeader(joiner))
      .send({ joinCode: mess.joinCode });
    expect(again.body.code).toBe("ALREADY_REQUESTED");

    const member = await request(app)
      .post(`${api}/join`)
      .set(authHeader(memberUser))
      .send({ joinCode: mess.joinCode });
    expect(member.body.code).toBe("ALREADY_MEMBER");
  });

  it("lets the requester cancel, and lets managers decline", async () => {
    const { mess, managerUser } = await messWithPeople();
    const a = await createUser();
    const b = await createUser();
    await request(app).post(`${api}/join`).set(authHeader(a)).send({ joinCode: mess.joinCode });
    await request(app).post(`${api}/join`).set(authHeader(b)).send({ joinCode: mess.joinCode });

    expect((await request(app).delete(`${api}/${mess.id}/join-request`).set(authHeader(a))).status).toBe(200);

    const pendingB = await prisma.messMember.findFirstOrThrow({ where: { userId: b.id } });
    const reject = await request(app)
      .post(`${api}/${mess.id}/members/${pendingB.id}/reject`)
      .set(authHeader(managerUser));
    expect(reject.status).toBe(200);
    expect(await prisma.messMember.count({ where: { userId: { in: [a.id, b.id] } } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: b.id, type: "JOIN_REJECTED" } })).toBe(1);
  });

  it("only managers see and handle join requests", async () => {
    const { mess, memberUser } = await messWithPeople();
    const joiner = await createUser();
    await request(app).post(`${api}/join`).set(authHeader(joiner)).send({ joinCode: mess.joinCode });
    const pending = await prisma.messMember.findFirstOrThrow({ where: { userId: joiner.id } });

    expect(
      (await request(app).get(`${api}/${mess.id}/members?status=PENDING`).set(authHeader(memberUser))).status,
    ).toBe(403);
    expect(
      (await request(app).post(`${api}/${mess.id}/members/${pending.id}/approve`).set(authHeader(memberUser)))
        .status,
    ).toBe(403);
  });
});

describe("listing members", () => {
  it("lists active members by role, and hides emails from non-managers", async () => {
    const { mess, admin, memberUser } = await messWithPeople();

    const asMember = await request(app).get(`${api}/${mess.id}/members`).set(authHeader(memberUser));
    expect(asMember.body.data.map((m: { role: string }) => m.role)).toEqual(["ADMIN", "MANAGER", "MEMBER"]);
    expect(asMember.body.data.every((m: { user: { email: null } }) => m.user.email === null)).toBe(true);
    expect(asMember.body.data[0].user.phone).toBe(admin.phone);

    const asAdmin = await request(app).get(`${api}/${mess.id}/members`).set(authHeader(admin));
    expect(asAdmin.body.data[0].user.email).toBe(admin.email);
  });
});

describe("roles and the last-admin rule", () => {
  it("lets admins promote and demote, and notifies the member", async () => {
    const { mess, admin, member, memberUser } = await messWithPeople();
    const res = await request(app)
      .patch(`${api}/${mess.id}/members/${member.id}/role`)
      .set(authHeader(admin))
      .send({ role: "ADMIN" });
    expect(res.body.data.role).toBe("ADMIN");
    expect(await prisma.notification.count({ where: { userId: memberUser.id, type: "ROLE_CHANGED" } })).toBe(
      1,
    );
  });

  it("never leaves a mess without an admin", async () => {
    const { mess, admin } = await messWithPeople();
    const adminMember = await prisma.messMember.findFirstOrThrow({ where: { userId: admin.id } });

    const demote = await request(app)
      .patch(`${api}/${mess.id}/members/${adminMember.id}/role`)
      .set(authHeader(admin))
      .send({ role: "MEMBER" });
    expect(demote.status).toBe(422);
    expect(demote.body.code).toBe("LAST_ADMIN");

    const leave = await request(app).post(`${api}/${mess.id}/leave`).set(authHeader(admin));
    expect(leave.body.code).toBe("LAST_ADMIN");
  });

  it("allows an admin to step down once there is another admin", async () => {
    const { mess, admin, member } = await messWithPeople();
    await prisma.messMember.update({ where: { id: member.id }, data: { role: "ADMIN" } });
    const adminMember = await prisma.messMember.findFirstOrThrow({ where: { userId: admin.id } });
    const res = await request(app)
      .patch(`${api}/${mess.id}/members/${adminMember.id}/role`)
      .set(authHeader(admin))
      .send({ role: "MEMBER" });
    expect(res.status).toBe(200);
  });

  it("is admin-only", async () => {
    const { mess, managerUser, member } = await messWithPeople();
    const res = await request(app)
      .patch(`${api}/${mess.id}/members/${member.id}/role`)
      .set(authHeader(managerUser))
      .send({ role: "MANAGER" });
    expect(res.status).toBe(403);
  });
});

describe("suspending, removing and leaving", () => {
  it("suspends and reactivates a member", async () => {
    const { mess, admin, member, memberUser } = await messWithPeople();
    await request(app)
      .post(`${api}/${mess.id}/members/${member.id}/suspend`)
      .set(authHeader(admin))
      .expect(200);
    expect((await request(app).get(`${api}/${mess.id}`).set(authHeader(memberUser))).status).toBe(403);

    await request(app)
      .post(`${api}/${mess.id}/members/${member.id}/reactivate`)
      .set(authHeader(admin))
      .expect(200);
    expect((await request(app).get(`${api}/${mess.id}`).set(authHeader(memberUser))).status).toBe(200);
  });

  it("removes a member, keeps their row as LEFT, and lets them ask to come back", async () => {
    const { mess, admin, member, memberUser } = await messWithPeople();
    await request(app)
      .delete(`${api}/${mess.id}/members/${member.id}`)
      .set(authHeader(admin))
      .send({ reason: "Moved out" })
      .expect(200);

    const row = await prisma.messMember.findUniqueOrThrow({ where: { id: member.id } });
    expect(row).toMatchObject({ status: "LEFT", leaveReason: "Moved out" });
    expect(row.leftAt).not.toBeNull();

    const back = await request(app)
      .post(`${api}/join`)
      .set(authHeader(memberUser))
      .send({ joinCode: mess.joinCode });
    expect(back.status).toBe(201);
    expect((await prisma.messMember.findUniqueOrThrow({ where: { id: member.id } })).status).toBe("PENDING");
  });

  it("lets members leave on their own and marks them as left in the group chat", async () => {
    const { mess, memberUser } = await messWithPeople();
    await prisma.conversationParticipant.create({
      data: {
        conversationId: (await prisma.conversation.findFirstOrThrow({ where: { messId: mess.id } })).id,
        userId: memberUser.id,
      },
    });
    await request(app).post(`${api}/${mess.id}/leave`).set(authHeader(memberUser)).send({}).expect(200);
    const participant = await prisma.conversationParticipant.findFirstOrThrow({
      where: { userId: memberUser.id },
    });
    expect(participant.leftAt).not.toBeNull();
  });

  it("doesn't let admins remove or suspend themselves", async () => {
    const { mess, admin } = await messWithPeople();
    const self = await prisma.messMember.findFirstOrThrow({ where: { userId: admin.id } });
    expect(
      (await request(app).delete(`${api}/${mess.id}/members/${self.id}`).set(authHeader(admin))).status,
    ).toBe(422);
    expect(
      (await request(app).post(`${api}/${mess.id}/members/${self.id}/suspend`).set(authHeader(admin))).status,
    ).toBe(422);
  });
});

describe("tenant isolation", () => {
  it("can't act on members of another mess", async () => {
    const { mess: messA, admin: adminA } = await messWithPeople();
    const { member: memberOfB } = await messWithPeople();

    // Admin of A uses A's URL but B's member id: must not find it.
    const res = await request(app)
      .patch(`${api}/${messA.id}/members/${memberOfB.id}/role`)
      .set(authHeader(adminA))
      .send({ role: "ADMIN" });
    expect(res.status).toBe(404);
    expect((await prisma.messMember.findUniqueOrThrow({ where: { id: memberOfB.id } })).role).toBe("MEMBER");
  });
});
