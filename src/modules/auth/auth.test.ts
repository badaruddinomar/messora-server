import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app.js";
import { prisma } from "../../lib/prisma.js";
import { createUser, TEST_PASSWORD } from "../../test/factories.js";

// Capture outgoing emails instead of sending them.
const sentMail = vi.hoisted(() => [] as { to: string; html: string }[]);
vi.mock("../../lib/mail/mailer.js", () => ({
  sendMail: vi.fn(async ({ to, html }: { to: { email: string }; html: string }) => {
    sentMail.push({ to: to.email, html });
  }),
}));

const lastCodeSentTo = (email: string) => {
  const mail = sentMail.findLast((m) => m.to === email);
  return mail?.html.match(/>(\d{6})</)?.[1];
};

/** Extracts the cookies a response set, for sending them on the next request. */
const cookiesFrom = (res: request.Response) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]);

const api = "/api/v1/auth";

beforeEach(() => {
  sentMail.length = 0;
});

describe("POST /auth/register", () => {
  it("creates the user, signs them in and emails a verification code", async () => {
    const res = await request(app).post(`${api}/register`).send({
      name: "Rahim Uddin",
      phone: "01712345678",
      email: "Rahim@Example.com",
      password: "password123",
    });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      name: "Rahim Uddin",
      phone: "+8801712345678",
      email: "rahim@example.com",
      emailVerifiedAt: null,
    });
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(cookiesFrom(res).map((c) => c.split("=")[0])).toEqual(["access_token", "refresh_token"]);
    await vi.waitFor(() => expect(lastCodeSentTo("rahim@example.com")).toMatch(/^\d{6}$/));
  });

  it("rejects a phone number that is already registered in another format", async () => {
    await createUser({ phone: "+8801712345678" });
    const res = await request(app)
      .post(`${api}/register`)
      .send({ name: "Karim", phone: "+880 1712-345678", password: "password123" });
    expect(res.status).toBe(409);
  });

  it("returns field errors for invalid input", async () => {
    const res = await request(app).post(`${api}/register`).send({ name: "K", phone: "12", password: "1" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VALIDATION_ERROR");
    expect(Object.keys(res.body.details).sort()).toEqual(["name", "password", "phone"]);
  });
});

describe("POST /auth/login", () => {
  it("accepts a phone number or an email", async () => {
    await createUser({ phone: "+8801812345678", email: "karim@example.com" });

    const byPhone = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "01812345678", password: TEST_PASSWORD });
    const byEmail = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "KARIM@example.com", password: TEST_PASSWORD });

    expect(byPhone.status).toBe(200);
    expect(byEmail.status).toBe(200);
    expect(byPhone.body.data.accessToken).toEqual(expect.any(String));
  });

  it("gives the same error for a wrong password and an unknown account", async () => {
    await createUser({ email: "karim@example.com" });
    const wrongPassword = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "karim@example.com", password: "nope-nope" });
    const unknown = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "nobody@example.com", password: "nope-nope" });

    expect(wrongPassword.status).toBe(401);
    expect(unknown.body).toEqual(wrongPassword.body);
    expect(wrongPassword.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("blocks blocked users", async () => {
    await createUser({ email: "blocked@example.com", status: "BLOCKED" });
    const res = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "blocked@example.com", password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BLOCKED");
  });
});

describe("sessions", () => {
  async function login() {
    const user = await createUser({ email: "session@example.com" });
    const res = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "session@example.com", password: TEST_PASSWORD });
    return { user, cookies: cookiesFrom(res) };
  }

  it("returns the current user from the access cookie", async () => {
    const { user, cookies } = await login();
    const res = await request(app).get(`${api}/me`).set("Cookie", cookies);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(user.id);
  });

  it("rejects requests without a valid token", async () => {
    expect((await request(app).get(`${api}/me`)).status).toBe(401);
    expect((await request(app).get(`${api}/me`).set("Authorization", "Bearer garbage")).status).toBe(401);
  });

  it("rotates the refresh token and revokes the whole family when an old one is reused", async () => {
    const { cookies } = await login();

    const first = await request(app).post(`${api}/refresh`).set("Cookie", cookies);
    expect(first.status).toBe(200);
    const rotated = cookiesFrom(first);

    // Replaying the original (now revoked) token logs the session out everywhere...
    const replay = await request(app).post(`${api}/refresh`).set("Cookie", cookies);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("SESSION_EXPIRED");

    // ...including the token that was issued by the legitimate rotation.
    expect((await request(app).post(`${api}/refresh`).set("Cookie", rotated)).status).toBe(401);
  });

  it("revokes the session on logout", async () => {
    const { cookies } = await login();
    expect((await request(app).post(`${api}/logout`).set("Cookie", cookies)).status).toBe(200);
    expect((await request(app).post(`${api}/refresh`).set("Cookie", cookies)).status).toBe(401);
  });
});

describe("email verification", () => {
  it("verifies the email with the emailed code and rejects wrong codes", async () => {
    const register = await request(app).post(`${api}/register`).send({
      name: "Verify Me",
      phone: "01912345678",
      email: "verify@example.com",
      password: "password123",
    });
    const cookies = cookiesFrom(register);
    await vi.waitFor(() => expect(lastCodeSentTo("verify@example.com")).toBeDefined());

    const wrong = await request(app)
      .post(`${api}/email/verify`)
      .set("Cookie", cookies)
      .send({ code: "000000" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("INVALID_CODE");

    const ok = await request(app)
      .post(`${api}/email/verify`)
      .set("Cookie", cookies)
      .send({ code: lastCodeSentTo("verify@example.com") });
    expect(ok.status).toBe(200);
    expect(ok.body.data.emailVerifiedAt).not.toBeNull();
  });

  it("locks the code after 5 wrong attempts", async () => {
    const register = await request(app).post(`${api}/register`).send({
      name: "Brute Force",
      phone: "01612345678",
      email: "brute@example.com",
      password: "password123",
    });
    const cookies = cookiesFrom(register);
    await vi.waitFor(() => expect(lastCodeSentTo("brute@example.com")).toBeDefined());

    for (let i = 0; i < 5; i++) {
      await request(app).post(`${api}/email/verify`).set("Cookie", cookies).send({ code: "000000" });
    }
    const correct = await request(app)
      .post(`${api}/email/verify`)
      .set("Cookie", cookies)
      .send({ code: lastCodeSentTo("brute@example.com") });
    expect(correct.status).toBe(400);
  });
});

describe("password reset", () => {
  it("resets the password with the emailed code and signs out other sessions", async () => {
    await createUser({ email: "forgot@example.com" });
    const session = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "forgot@example.com", password: TEST_PASSWORD });

    const forgot = await request(app).post(`${api}/password/forgot`).send({ email: "forgot@example.com" });
    expect(forgot.status).toBe(200);

    const reset = await request(app)
      .post(`${api}/password/reset`)
      .send({
        email: "forgot@example.com",
        code: lastCodeSentTo("forgot@example.com"),
        password: "brand-new-pass",
      });
    expect(reset.status).toBe(200);

    expect((await request(app).post(`${api}/refresh`).set("Cookie", cookiesFrom(session))).status).toBe(401);
    const login = await request(app)
      .post(`${api}/login`)
      .send({ identifier: "forgot@example.com", password: "brand-new-pass" });
    expect(login.status).toBe(200);
  });

  it("doesn't reveal whether an email is registered", async () => {
    const res = await request(app).post(`${api}/password/forgot`).send({ email: "ghost@example.com" });
    expect(res.status).toBe(200);
    expect(sentMail).toHaveLength(0);
  });

  it("enforces a cooldown between codes", async () => {
    await createUser({ email: "cooldown@example.com" });
    await request(app).post(`${api}/password/forgot`).send({ email: "cooldown@example.com" });
    const again = await request(app).post(`${api}/password/forgot`).send({ email: "cooldown@example.com" });
    expect(again.status).toBe(429);
    expect(again.body.code).toBe("CODE_COOLDOWN");
    expect(await prisma.verificationCode.count()).toBe(1);
  });
});
