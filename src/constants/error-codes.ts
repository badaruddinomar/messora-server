/**
 * Machine-readable error codes sent as `code` in error responses.
 * Clients branch on these, never on `message` (which is for humans and may change).
 */
export const ERROR_CODES = {
  // Generic (one per HTTP status)
  BAD_REQUEST: "BAD_REQUEST",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL_ERROR: "INTERNAL_ERROR",

  // Auth
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_BLOCKED: "ACCOUNT_BLOCKED",
  SESSION_EXPIRED: "SESSION_EXPIRED",
  INVALID_CODE: "INVALID_CODE",
  CODE_COOLDOWN: "CODE_COOLDOWN",

  // Tenant
  NOT_A_MEMBER: "NOT_A_MEMBER",
  MEMBERSHIP_INACTIVE: "MEMBERSHIP_INACTIVE",
  INSUFFICIENT_ROLE: "INSUFFICIENT_ROLE",

  // Business rules (HTTP 422)
  MONTH_CLOSED: "MONTH_CLOSED",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
