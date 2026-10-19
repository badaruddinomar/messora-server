import type { CookieOptions, Response } from "express";
import { env } from "../../config/env.js";
import { API_PREFIX, COOKIES } from "../../constants/index.js";

const base: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SAMESITE,
};

// Refresh token is only ever sent to the auth routes.
const refreshPath = `${API_PREFIX}/auth`;

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshExpiresAt: Date) {
  res.cookie(COOKIES.ACCESS_TOKEN, accessToken, { ...base, path: "/" });
  res.cookie(COOKIES.REFRESH_TOKEN, refreshToken, { ...base, path: refreshPath, expires: refreshExpiresAt });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(COOKIES.ACCESS_TOKEN, { ...base, path: "/" });
  res.clearCookie(COOKIES.REFRESH_TOKEN, { ...base, path: refreshPath });
}
