import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../../test/factories.js";

const sentMail = vi.hoisted(() => [] as { to: string; html: string; subject: string }[]);
vi.mock("../../lib/mail/mailer.js", () => ({
  sendMail: vi.fn(async ({ to, html, subject }: { to: { email: string }; html: string; subject: string }) => {
    sentMail.push({ to: to.email, html, subject });
  }),
}));

const api = "/api/v1";
const tokenFrom = (url: string) => url.split("/invite/")[1];

beforeEach(() => {
  sentMail.length = 0;
});

async function setup() {
  const admin = await createUser({ name: "Rahim <b>Admin</b>" });
  const { mess } = await createMess(admin, { name: "Green House" });
  return { admin, mess };
}

describe("creating invitations", () => {
  it("emails an invitation link and returns it for sharing", async () => {
    const { admin, mess } = await setup();
    const res = await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(admin))
      .send({ email: "New.Person@example.com" });

    expect(res.status).toBe(201);
    expect(res.body.data.emailSent).toBe(true);
    expect(res.body.data.inviteUrl).toMatch(/^http:\/\/localhost:3000\/invite\/[a-f0-9]{64}$/);
    expect(res.body.data.invitation).toMatchObject({
      email: "new.person@example.com",
      role: "MEMBER",
      status: "PENDING",
    });

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].html).toContain(res.body.data.inviteUrl);
    // Names are escaped in the email HTML.
    expect(sentMail[0].html).toContain("Rahim &lt;b&gt;Admin&lt;/b&gt;");
    expect(
      await prisma.messInvitation.count({ where: { tokenHash: tokenFrom(res.body.data.inviteUrl) } }),
    ).toBe(0);
  });

  it("supports phone-only invitations (shared by the manager) and replaces older ones", async () => {
    const { admin, mess } = await setup();
    const send = () =>
      request(app)
        .post(`${api}/messes/${mess.id}/invitations`)
        .set(authHeader(admin))
        .send({ phone: "01712345678" });
    await send();
    const second = await send();

    expect(second.body.data.emailSent).toBe(false);
    expect(sentMail).toHaveLength(0);
    const rows = await prisma.messInvitation.findMany({
      where: { messId: mess.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => [r.phone, r.status])).toEqual([
      ["+8801712345678", "REVOKED"],
      ["+8801712345678", "PENDING"],
    ]);
  });

  it("refuses to invite existing members, and only admins can invite managers", async () => {
    const { admin, mess } = await setup();
    const managerUser = await createUser();
    await addMember(mess.id, managerUser, { role: "MANAGER" });

    const existing = await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(admin))
      .send({ phone: managerUser.phone });
    expect(existing.body.code).toBe("ALREADY_MEMBER");

    const asManager = await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(managerUser))
      .send({ email: "x@example.com", role: "MANAGER" });
    expect(asManager.status).toBe(403);

    const noTarget = await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(admin))
      .send({});
    expect(noTarget.status).toBe(400);
  });
});

describe("accepting invitations", () => {
  it("previews publicly, then makes the person an active member with the invited role", async () => {
    const { admin, mess } = await setup();
    const invite = await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(admin))
      .send({ email: "karim@example.com", role: "MANAGER" });
    const token = tokenFrom(invite.body.data.inviteUrl);

    const preview = await request(app).get(`${api}/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ messName: "Green House", role: "MANAGER", status: "PENDING" });

    const karim = await createUser({ email: "karim@example.com" });
    const accept = await request(app).post(`${api}/invitations/${token}/accept`).set(authHeader(karim));
    expect(accept.status).toBe(200);
    expect(accept.body.data.membership).toMatchObject({ role: "MANAGER", status: "ACTIVE" });

    // Single use.
    const again = await request(app)
      .post(`${api}/invitations/${token}/accept`)
      .set(authHeader(await createUser()));
    expect(again.body.code).toBe("INVITATION_INVALID");
    expect(
      await prisma.notification.count({ where: { userId: admin.id, title: "Invitation accepted" } }),
    ).toBe(1);
  });

  it("shows invitations sent to the user's phone, which they can accept from the app", async () => {
    const { admin, mess } = await setup();
    await request(app)
      .post(`${api}/messes/${mess.id}/invitations`)
      .set(authHeader(admin))
      .send({ phone: "01812345678" });

    const invitee = await createUser({ phone: "+8801812345678" });
    const received = await request(app).get(`${api}/invitations/received`).set(authHeader(invitee));
    expect(received.body.data).toHaveLength(1);

    // Someone else can't accept it by id.
    const stranger = await createUser();
    const steal = await request(app)
      .post(`${api}/invitations/received/${received.body.data[0].id}/accept`)
      .set(authHeader(stranger));
    expect(steal.status).toBe(404);

    const accept = await request(app)
      .post(`${api}/invitations/received/${received.body.data[0].id}/accept`)
      .set(authHeader(invitee));
    expect(accept.status).toBe(200);
    expect(
      (await request(app).get(`${api}/invitations/received`).set(authHeader(invitee))).body.data,
    ).toEqual([]);
  });

  it("rejects expired, revoked and declined invitations", async () => {
    const { admin, mess } = await setup();
    const make = async (email: string) => {
      const res = await request(app)
        .post(`${api}/messes/${mess.id}/invitations`)
        .set(authHeader(admin))
        .send({ email });
      return { token: tokenFrom(res.body.data.inviteUrl), id: res.body.data.invitation.id as string };
    };
    const user = await createUser();

    const expired = await make("a@example.com");
    await prisma.messInvitation.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await request(app).get(`${api}/invitations/${expired.token}`)).body.data.status).toBe("EXPIRED");
    expect(
      (await request(app).post(`${api}/invitations/${expired.token}/accept`).set(authHeader(user))).status,
    ).toBe(422);

    const revoked = await make("b@example.com");
    await request(app)
      .delete(`${api}/messes/${mess.id}/invitations/${revoked.id}`)
      .set(authHeader(admin))
      .expect(200);
    expect(
      (await request(app).post(`${api}/invitations/${revoked.token}/accept`).set(authHeader(user))).status,
    ).toBe(422);

    const declined = await make("c@example.com");
    await request(app).post(`${api}/invitations/${declined.token}/decline`).set(authHeader(user)).expect(200);
    expect(
      (await request(app).post(`${api}/invitations/${declined.token}/accept`).set(authHeader(user))).status,
    ).toBe(422);

    const list = await request(app).get(`${api}/messes/${mess.id}/invitations`).set(authHeader(admin));
    expect(list.body.data.map((i: { status: string }) => i.status)).toEqual(["EXPIRED"]);
  });

  it("returns 404 for unknown tokens and 400 for malformed ones", async () => {
    expect((await request(app).get(`${api}/invitations/${"a".repeat(64)}`)).status).toBe(404);
    expect((await request(app).get(`${api}/invitations/not-a-token`)).status).toBe(400);
  });
});
