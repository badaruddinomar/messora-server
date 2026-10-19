import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { prisma } from "../lib/prisma.js";
import { addMember, authHeader, createMess, createUser } from "../test/factories.js";
import { requireAuth } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "./tenant.js";

// A tiny app with one route per permission level, echoing the membership the middleware resolved.
const app = express();
const echo: express.RequestHandler = (req, res) => {
  res.json({ membership: req.membership });
};
app.get("/messes/:messId/any", requireAuth, requireMessMember(), echo);
app.get("/messes/:messId/managers", requireAuth, requireMessMember(MANAGER_ACCESS), echo);
app.get("/messes/:messId/admins", requireAuth, requireMessMember(ADMIN_ONLY), echo);
app.use(errorHandler);

describe("requireMessMember", () => {
  it("lets an active member in and exposes their membership", async () => {
    const owner = await createUser();
    const { mess, ownerMember } = await createMess(owner);

    const res = await request(app).get(`/messes/${mess.id}/any`).set(authHeader(owner));
    expect(res.status).toBe(200);
    expect(res.body.membership).toMatchObject({ id: ownerMember.id, messId: mess.id, role: "ADMIN" });
  });

  it("returns 404 (not 403) for a mess the user doesn't belong to, so its existence isn't leaked", async () => {
    const { mess } = await createMess(await createUser());
    const outsider = await createUser();

    const res = await request(app).get(`/messes/${mess.id}/any`).set(authHeader(outsider));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_A_MEMBER");
  });

  it("isolates tenants: a member of mess A can't use mess B", async () => {
    const userA = await createUser();
    await createMess(userA);
    const { mess: messB } = await createMess(await createUser());

    expect((await request(app).get(`/messes/${messB.id}/any`).set(authHeader(userA))).status).toBe(404);
  });

  it("returns 404 for malformed ids and deactivated messes", async () => {
    const owner = await createUser();
    const { mess } = await createMess(owner);
    expect((await request(app).get(`/messes/not-a-uuid/any`).set(authHeader(owner))).status).toBe(404);

    await prisma.mess.update({ where: { id: mess.id }, data: { isActive: false } });
    expect((await request(app).get(`/messes/${mess.id}/any`).set(authHeader(owner))).status).toBe(404);
  });

  it.each(["PENDING", "SUSPENDED", "LEFT"] as const)("blocks %s members", async (status) => {
    const { mess } = await createMess(await createUser());
    const user = await createUser();
    await addMember(mess.id, user, { status });

    const res = await request(app).get(`/messes/${mess.id}/any`).set(authHeader(user));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MEMBERSHIP_INACTIVE");
  });

  it("requires authentication", async () => {
    const { mess } = await createMess(await createUser());
    expect((await request(app).get(`/messes/${mess.id}/any`)).status).toBe(401);
  });

  describe("roles", () => {
    it("enforces manager and admin levels", async () => {
      const owner = await createUser();
      const { mess } = await createMess(owner);
      const manager = await createUser();
      const member = await createUser();
      await addMember(mess.id, manager, { role: "MANAGER" });
      await addMember(mess.id, member);

      const status = async (path: string, user: typeof owner) =>
        (await request(app).get(`/messes/${mess.id}/${path}`).set(authHeader(user))).status;

      expect(await status("managers", owner)).toBe(200);
      expect(await status("managers", manager)).toBe(200);
      expect(await status("managers", member)).toBe(403);
      expect(await status("admins", owner)).toBe(200);
      expect(await status("admins", manager)).toBe(403);
    });

    it("gives manager access to the OPEN month's assigned manager only", async () => {
      const { mess, month } = await createMess(await createUser());
      const user = await createUser();
      const member = await addMember(mess.id, user);
      const path = `/messes/${mess.id}/managers`;

      expect((await request(app).get(path).set(authHeader(user))).status).toBe(403);

      await prisma.messMonth.update({ where: { id: month.id }, data: { managerId: member.id } });
      const res = await request(app).get(path).set(authHeader(user));
      expect(res.status).toBe(200);
      expect(res.body.membership.isMonthManager).toBe(true);

      // Managing a closed month grants nothing.
      await prisma.messMonth.update({ where: { id: month.id }, data: { status: "CLOSED" } });
      expect((await request(app).get(path).set(authHeader(user))).status).toBe(403);
      // ...and month managers never get admin-only access.
      expect((await request(app).get(`/messes/${mess.id}/admins`).set(authHeader(user))).status).toBe(403);
    });
  });
});
