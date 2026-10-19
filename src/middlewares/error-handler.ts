import type { ErrorRequestHandler, RequestHandler } from "express";
import { Prisma } from "@prisma/client";
import { ZodError, z } from "zod";
import { isProd } from "../config/env.js";
import { ERROR_CODES, type ErrorCode } from "../constants/error-codes.js";
import { logger } from "../lib/logger.js";
import { ApiError } from "../utils/api-error.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let statusCode = 500;
  let code: ErrorCode = ERROR_CODES.INTERNAL_ERROR;
  let message = "Internal server error";
  let details: unknown;

  if (err instanceof ApiError) {
    ({ statusCode, code, message, details } = err);
  } else if (err instanceof ZodError) {
    statusCode = 400;
    code = ERROR_CODES.VALIDATION_ERROR;
    message = "Validation failed";
    details = z.flattenError(err).fieldErrors;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      statusCode = 409;
      code = ERROR_CODES.CONFLICT;
      message = "A record with this value already exists";
    } else if (err.code === "P2025") {
      statusCode = 404;
      code = ERROR_CODES.NOT_FOUND;
      message = "Record not found";
    }
  } else if (err instanceof SyntaxError && "body" in err) {
    statusCode = 400;
    code = ERROR_CODES.BAD_REQUEST;
    message = "Malformed JSON body";
  }

  if (statusCode >= 500) (req.log ?? logger).error({ err }, "Unhandled error");

  res.status(statusCode).json({
    success: false,
    code,
    message,
    ...(details !== undefined && { details }),
    ...(!isProd && statusCode >= 500 && { stack: (err as Error)?.stack }),
  });
};
