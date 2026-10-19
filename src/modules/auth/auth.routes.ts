import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { strictLimiter } from "../../middlewares/rate-limit.js";
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
