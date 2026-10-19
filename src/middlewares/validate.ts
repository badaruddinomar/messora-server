import type { RequestHandler } from "express";
import type { ZodType } from "zod";

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and replaces req.body / req.query / req.params with the parsed (coerced) values.
 * Zod errors are forwarded to the error handler.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    if (schemas.body) req.body = schemas.body.parse(req.body);
    // In Express 5 req.query/req.params are getters, so redefine them instead of assigning.
    if (schemas.query) {
      Object.defineProperty(req, "query", { value: schemas.query.parse(req.query), writable: true });
    }
    if (schemas.params) {
      Object.defineProperty(req, "params", { value: schemas.params.parse(req.params), writable: true });
    }
    next();
  };
