import { ERROR_CODES, type ErrorCode } from "../constants/error-codes.js";

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code: ErrorCode = defaultCode(statusCode),
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(message = "Bad request", code: ErrorCode = ERROR_CODES.BAD_REQUEST, details?: unknown) {
    return new ApiError(400, message, code, details);
  }
  static unauthorized(message = "Unauthorized", code: ErrorCode = ERROR_CODES.UNAUTHORIZED) {
    return new ApiError(401, message, code);
  }
  static forbidden(message = "Forbidden", code: ErrorCode = ERROR_CODES.FORBIDDEN) {
    return new ApiError(403, message, code);
  }
  static notFound(message = "Not found", code: ErrorCode = ERROR_CODES.NOT_FOUND) {
    return new ApiError(404, message, code);
  }
  static conflict(message = "Conflict", code: ErrorCode = ERROR_CODES.CONFLICT) {
    return new ApiError(409, message, code);
  }
  /** A valid request that breaks a business rule (e.g. editing a closed month). */
  static unprocessable(message: string, code: ErrorCode) {
    return new ApiError(422, message, code);
  }
  static tooManyRequests(
    message = "Too many requests, please try again later",
    code: ErrorCode = ERROR_CODES.RATE_LIMITED,
  ) {
    return new ApiError(429, message, code);
  }
}

function defaultCode(statusCode: number): ErrorCode {
  switch (statusCode) {
    case 400:
      return ERROR_CODES.BAD_REQUEST;
    case 401:
      return ERROR_CODES.UNAUTHORIZED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.CONFLICT;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return ERROR_CODES.INTERNAL_ERROR;
  }
}
