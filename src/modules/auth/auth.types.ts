import type { User } from "@prisma/client";

/** Request metadata stored with each refresh token. */
export interface ClientInfo {
  userAgent?: string;
  ip?: string;
}

export type PublicUser = Omit<User, "passwordHash" | "deletedAt">;
