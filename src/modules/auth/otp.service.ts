import { VerificationPurpose } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { ApiError } from "../../utils/api-error.js";
import { generateOtp, hashOtp } from "../../utils/crypto.js";

const MINUTE = 60 * 1000;

export const OTP_TTL_MINUTES: Record<VerificationPurpose, number> = {
  PHONE_VERIFY: 10,
  EMAIL_VERIFY: 15,
  PASSWORD_RESET: 10,
  LOGIN_OTP: 5,
};

const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

/** Creates a new code (invalidating older unconsumed ones) and returns the plain code to deliver. */
export async function issueOtp(params: { target: string; purpose: VerificationPurpose; userId?: string }) {
  const { target, purpose, userId } = params;

  const latest = await prisma.verificationCode.findFirst({
    where: { target, purpose },
    orderBy: { createdAt: "desc" },
  });
  if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
    throw new ApiError(429, "Please wait a minute before requesting another code");
  }

  const code = generateOtp();
  await prisma.$transaction([
    prisma.verificationCode.updateMany({
      where: { target, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
    prisma.verificationCode.create({
      data: {
        target,
        purpose,
        userId,
        codeHash: hashOtp(target, purpose, code),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES[purpose] * MINUTE),
      },
    }),
  ]);

  return code;
}

/** Verifies and consumes the latest active code. Throws on wrong/expired code. */
export async function consumeOtp(params: { target: string; purpose: VerificationPurpose; code: string }) {
  const { target, purpose, code } = params;
  const invalid = () => ApiError.badRequest("Invalid or expired code");

  const record = await prisma.verificationCode.findFirst({
    where: { target, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
  });
  if (!record || record.expiresAt < new Date() || record.attempts >= MAX_ATTEMPTS) throw invalid();

  if (record.codeHash !== hashOtp(target, purpose, code)) {
    await prisma.verificationCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw invalid();
  }

  await prisma.verificationCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  return record;
}
