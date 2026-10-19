import type { PlatformRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; platformRole: PlatformRole };
    }
  }
}

export {};
