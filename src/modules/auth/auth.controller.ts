import type { Request, Response } from "express";
import { COOKIES } from "../../constants/index.js";
import { sendResponse } from "../../utils/send-response.js";
import { clearAuthCookies, setAuthCookies } from "./auth.cookies.js";
import * as authService from "./auth.service.js";
import type { ClientInfo } from "./auth.types.js";

const clientInfo = (req: Request): ClientInfo => ({
  userAgent: req.get("user-agent"),
  ip: req.ip,
});

type Session = Awaited<ReturnType<typeof authService.login>>;

/** Sets cookies for the web client and also returns the access token for mobile clients. */
function respondWithSession(res: Response, session: Session, statusCode = 200, message = "OK") {
  setAuthCookies(res, session.accessToken, session.refreshToken, session.refreshExpiresAt);
  return sendResponse(res, {
    statusCode,
    message,
    data: { user: session.user, accessToken: session.accessToken },
  });
}

export async function register(req: Request, res: Response) {
  const session = await authService.register(req.body, clientInfo(req));
  respondWithSession(res, session, 201, "Account created");
}

export async function login(req: Request, res: Response) {
  const session = await authService.login(req.body, clientInfo(req));
  respondWithSession(res, session, 200, "Logged in");
}

export async function refresh(req: Request, res: Response) {
  // Mobile clients send the refresh token in the body; web relies on the cookie.
  const token = req.cookies?.[COOKIES.REFRESH_TOKEN] ?? req.body?.refreshToken;
  try {
    const session = await authService.refresh(token, clientInfo(req));
    respondWithSession(res, session, 200, "Session refreshed");
  } catch (err) {
    clearAuthCookies(res);
    throw err;
  }
}

export async function logout(req: Request, res: Response) {
  await authService.logout(req.cookies?.[COOKIES.REFRESH_TOKEN] ?? req.body?.refreshToken);
  clearAuthCookies(res);
  sendResponse(res, { message: "Logged out" });
}

export async function me(req: Request, res: Response) {
  sendResponse(res, { data: await authService.getMe(req.user!.id) });
}

export async function sendEmailVerification(req: Request, res: Response) {
  await authService.resendEmailVerification(req.user!.id);
  sendResponse(res, { message: "Verification code sent" });
}

export async function verifyEmail(req: Request, res: Response) {
  const user = await authService.verifyEmail(req.user!.id, req.body.code);
  sendResponse(res, { message: "Email verified", data: user });
}

export async function forgotPassword(req: Request, res: Response) {
  await authService.forgotPassword(req.body.email);
  sendResponse(res, { message: "If an account exists for this email, a reset code has been sent" });
}

export async function resetPassword(req: Request, res: Response) {
  await authService.resetPassword(req.body);
  clearAuthCookies(res);
  sendResponse(res, { message: "Password updated, please log in" });
}
