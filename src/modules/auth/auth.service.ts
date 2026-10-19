import bcrypt from "bcryptjs";
import jwt, { type SignOptions } from "jsonwebtoken";
import { UserStatus, VerificationPurpose, type User } from "@prisma/client";
import { env } from "../../config/env.js";
import { prisma } from "../../lib/prisma.js";
import { sendMail } from "../../lib/mail.js";
import { resetPasswordTemplate, verifyEmailTemplate } from "../../lib/email-templates.js";
import { ApiError } from "../../utils/api-error.js";
import { generateId, generateToken, hashToken } from "../../utils/crypto.js";
import { consumeOtp, issueOtp, OTP_TTL_MINUTES } from "./otp.service.js";
import { emailField, phoneField, type LoginInput, type RegisterInput, type ResetPasswordInput } from "./auth.schema.js";

const DAY = 24 * 60 * 60 * 1000;

export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

export type PublicUser = Omit<User, "passwordHash" | "deletedAt">;

export const toPublicUser = ({ passwordHash: _p, deletedAt: _d, ...user }: User): PublicUser => user;

// ---------- sessions ----------

function signAccessToken(user: Pick<User, "id" | "platformRole">) {
  return jwt.sign({ role: user.platformRole }, env.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions["expiresIn"],
  });
}

/** Issues an access token + refresh token. A new login starts a new refresh-token family. */
async function issueSession(user: User, client: ClientInfo, familyId: string = generateId()) {
  const refreshToken = generateToken();
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * DAY);

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      familyId,
      userAgent: client.userAgent?.slice(0, 255),
      ip: client.ip,
      expiresAt: refreshExpiresAt,
    },
  });

  return { accessToken: signAccessToken(user), refreshToken, refreshExpiresAt, user: toPublicUser(user) };
}

function assertActive(user: User) {
  if (user.status === UserStatus.BLOCKED) throw ApiError.forbidden("Your account has been blocked");
  if (user.status === UserStatus.DELETED) throw ApiError.unauthorized("Account not found");
}

async function sendEmailVerification(user: User) {
  if (!user.email) throw ApiError.badRequest("Add an email address first");
  const code = await issueOtp({ target: user.email, purpose: VerificationPurpose.EMAIL_VERIFY, userId: user.id });
  await sendMail({
    to: { email: user.email, name: user.name },
    subject: "Your Messora verification code",
    html: verifyEmailTemplate(user.name, code, OTP_TTL_MINUTES.EMAIL_VERIFY),
  });
}

// ---------- use cases ----------

export async function register(input: RegisterInput, client: ClientInfo) {
  const existing = await prisma.user.findFirst({
    where: { OR: [{ phone: input.phone }, ...(input.email ? [{ email: input.email }] : [])] },
    select: { phone: true },
  });
  if (existing) {
    throw ApiError.conflict(
      existing.phone === input.phone
        ? "An account with this phone number already exists"
        : "An account with this email already exists",
    );
  }

  const user = await prisma.user.create({
    data: {
      name: input.name,
      phone: input.phone,
      email: input.email,
      passwordHash: await bcrypt.hash(input.password, 12),
    },
  });

  if (user.email) {
    // Don't fail registration if the email provider is down; the user can resend.
    sendEmailVerification(user).catch((err) => console.error("Failed to send verification email", err));
  }

  return issueSession(user, client);
}

export async function login({ identifier, password }: LoginInput, client: ClientInfo) {
  const asEmail = emailField.safeParse(identifier);
  const asPhone = phoneField.safeParse(identifier);
  const where = asEmail.success
    ? { email: asEmail.data }
    : asPhone.success
      ? { phone: asPhone.data }
      : null;

  const user = where ? await prisma.user.findFirst({ where }) : null;
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    throw ApiError.unauthorized("Invalid credentials");
  }
  assertActive(user);

  return issueSession(user, client);
}

/** Rotates the refresh token within its family. Reusing an old token revokes the whole family. */
export async function refresh(refreshToken: string | undefined, client: ClientInfo) {
  if (!refreshToken) throw ApiError.unauthorized("Missing refresh token");

  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    include: { user: true },
  });
  if (!record || record.expiresAt < new Date()) {
    throw ApiError.unauthorized("Invalid or expired refresh token");
  }

  if (record.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: record.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthorized("Session expired, please log in again");
  }

  assertActive(record.user);

  // Conditional update so two concurrent refreshes can't both rotate the same token.
  const { count } = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (count === 0) throw ApiError.unauthorized("Session expired, please log in again");

  return issueSession(record.user, client, record.familyId);
}

export async function logout(refreshToken: string | undefined) {
  if (!refreshToken) return;
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) } });
  if (!record) return;
  await prisma.refreshToken.updateMany({
    where: { familyId: record.familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized("User no longer exists");
  assertActive(user);
  return toPublicUser(user);
}

export async function resendEmailVerification(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) throw ApiError.badRequest("Email is already verified");
  await sendEmailVerification(user);
}

export async function verifyEmail(userId: string, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.email) throw ApiError.badRequest("No email address on this account");
  if (user.emailVerifiedAt) return toPublicUser(user);

  await consumeOtp({ target: user.email, purpose: VerificationPurpose.EMAIL_VERIFY, code });
  const updated = await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
  return toPublicUser(updated);
}

export async function forgotPassword(email: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  // Same response whether or not the account exists, to avoid leaking which emails are registered.
  if (!user || user.status !== UserStatus.ACTIVE) return;

  const code = await issueOtp({ target: email, purpose: VerificationPurpose.PASSWORD_RESET, userId: user.id });
  await sendMail({
    to: { email, name: user.name },
    subject: "Your Messora password reset code",
    html: resetPasswordTemplate(user.name, code, OTP_TTL_MINUTES.PASSWORD_RESET),
  });
}

export async function resetPassword({ email, code, password }: ResetPasswordInput) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw ApiError.badRequest("Invalid or expired code");

  await consumeOtp({ target: email, purpose: VerificationPurpose.PASSWORD_RESET, code });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      // Receiving the code also proves ownership of the email.
      data: { passwordHash: await bcrypt.hash(password, 12), emailVerifiedAt: user.emailVerifiedAt ?? new Date() },
    }),
    // Sign out every device after a password change.
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}
