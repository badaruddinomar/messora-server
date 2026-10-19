import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import type { PlatformRole } from "@prisma/client";
import { env } from "../config/env.js";
import { ACCESS_COOKIE } from "../modules/auth/auth.cookies.js";
import { ApiError } from "../utils/api-error.js";

interface AccessPayload {
  sub: string;
  role: PlatformRole;
}

/** Requires a valid access token (cookie for web, `Authorization: Bearer` for mobile). */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  const token =
    req.cookies?.[ACCESS_COOKIE] ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);

  if (!token) throw ApiError.unauthorized("Not authenticated");

  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
    req.user = { id: payload.sub, platformRole: payload.role };
  } catch {
    throw ApiError.unauthorized("Invalid or expired access token");
  }
  next();
};

export const requireSuperAdmin: RequestHandler = (req, _res, next) => {
  if (req.user?.platformRole !== "SUPER_ADMIN") throw ApiError.forbidden();
  next();
};
