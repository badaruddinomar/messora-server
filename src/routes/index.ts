import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes.js";

/** Mounts every feature module under the API prefix. */
const router = Router();

router.use("/auth", authRoutes);

export default router;
