import type { Response } from "express";

export function sendResponse<T>(
  res: Response,
  { statusCode = 200, message = "OK", data }: { statusCode?: number; message?: string; data?: T },
) {
  return res.status(statusCode).json({ success: true, message, data: data ?? null });
}
