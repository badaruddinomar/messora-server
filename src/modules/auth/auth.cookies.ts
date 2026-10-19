import type { CookieOptions, Response } from "express";
import { env } from "../../config/env.js";

export const ACCESS_COOKIE = "access_token";
export const REFRESH_COOKIE = "refresh_token";

const base: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
};

// Refresh token is only ever sent to the auth routes.
const refreshPath = "/api/v1/auth";

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: "/" });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: refreshPath, expires: refreshExpiresAt });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...base, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: refreshPath });
}
