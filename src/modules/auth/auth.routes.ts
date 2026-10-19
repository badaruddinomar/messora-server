import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as ctrl from "./auth.controller.js";
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyCodeSchema,
} from "./auth.schema.js";

const router = Router();

const strictLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false });

router.post("/register", strictLimiter, validate({ body: registerSchema }), ctrl.register);
router.post("/login", strictLimiter, validate({ body: loginSchema }), ctrl.login);
router.post("/refresh", ctrl.refresh);
router.post("/logout", ctrl.logout);
router.get("/me", requireAuth, ctrl.me);

router.post("/email/send-verification", requireAuth, strictLimiter, ctrl.sendEmailVerification);
router.post("/email/verify", requireAuth, validate({ body: verifyCodeSchema }), ctrl.verifyEmail);

router.post("/password/forgot", strictLimiter, validate({ body: forgotPasswordSchema }), ctrl.forgotPassword);
router.post("/password/reset", strictLimiter, validate({ body: resetPasswordSchema }), ctrl.resetPassword);

export default router;
