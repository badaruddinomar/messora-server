import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { MemberStatus, MessRole, type User } from "@prisma/client";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { generateCode } from "../utils/crypto.js";
import { toDbDate } from "../utils/date.js";

export const TEST_PASSWORD = "password123";
// Low cost keeps tests fast; production code uses cost 12.
const passwordHash = bcrypt.hashSync(TEST_PASSWORD, 4);

let sequence = 0;
const next = () => ++sequence;

export async function createUser(overrides: Partial<Parameters<typeof prisma.user.create>[0]["data"]> = {}) {
  const n = next();
  return prisma.user.create({
    data: {
      name: `Test User ${n}`,
      phone: `+88017${String(n).padStart(8, "0")}`,
      email: `user${n}@example.com`,
      passwordHash,
      ...overrides,
    },
  });
}

/** A mess with an ADMIN owner and an OPEN month for October 2026. */
export async function createMess(owner: User, overrides: { name?: string } = {}) {
  const n = next();
  const mess = await prisma.mess.create({
    data: {
      name: overrides.name ?? `Test Mess ${n}`,
      slug: `test-mess-${n}`,
      joinCode: generateCode(),
      createdById: owner.id,
      settings: { create: {} },
      members: { create: { userId: owner.id, role: MessRole.ADMIN, status: MemberStatus.ACTIVE } },
      months: {
        create: { year: 2026, month: 10, startDate: toDbDate("2026-10-01"), endDate: toDbDate("2026-10-31") },
      },
    },
    include: { members: true, months: true },
  });
  return { mess, ownerMember: mess.members[0], month: mess.months[0] };
}

export function addMember(
  messId: string,
  user: User,
  { role = MessRole.MEMBER, status = MemberStatus.ACTIVE }: { role?: MessRole; status?: MemberStatus } = {},
) {
  return prisma.messMember.create({ data: { messId, userId: user.id, role, status } });
}

/** `Authorization` header for a user, without going through the login endpoint. */
export const authHeader = (user: Pick<User, "id" | "platformRole">) => ({
  Authorization: `Bearer ${jwt.sign({ role: user.platformRole }, env.JWT_ACCESS_SECRET, { subject: user.id, expiresIn: "5m" })}`,
});
