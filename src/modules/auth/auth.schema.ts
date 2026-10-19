import { z } from "zod";

export const emailField = z.email().trim().toLowerCase();

/**
 * Accepts international numbers ("+8801712345678") and local Bangladeshi numbers ("01712345678"),
 * and normalizes them to E.164 so the same phone can't register twice in different formats.
 */
export const phoneField = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, ""))
  .transform((v) => (/^01\d{9}$/.test(v) ? `+88${v}` : v))
  .pipe(z.string().regex(/^\+[1-9]\d{7,14}$/, "Enter a valid phone number"));

const passwordField = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

const otpField = z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits");

export const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  phone: phoneField,
  email: emailField.optional(),
  password: passwordField,
});

/** `identifier` is either a phone number or an email address. */
export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "Phone or email is required"),
  password: z.string().min(1, "Password is required"),
});

export const verifyCodeSchema = z.object({ code: otpField });

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z.object({
  email: emailField,
  code: otpField,
  password: passwordField,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
