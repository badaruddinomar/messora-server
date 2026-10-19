import type { MemberStatus, MessRole, PlatformRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      user?: { id: string; platformRole: PlatformRole };
      /** Set by `requireMessMember` on mess-scoped routes. */
      membership?: {
        id: string;
        messId: string;
        userId: string;
        role: MessRole;
        status: MemberStatus;
        /** True when access was granted because the member manages the OPEN month. */
        isMonthManager: boolean;
      };
    }
  }
}

export {};
