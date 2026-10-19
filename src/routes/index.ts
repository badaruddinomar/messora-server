import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes.js";
import invitationRoutes from "../modules/invitations/invitations.routes.js";
import messRoutes from "../modules/messes/messes.routes.js";

/** Mounts every feature module under the API prefix. */
const router = Router();

router.use("/auth", authRoutes);
router.use("/messes", messRoutes);
router.use("/invitations", invitationRoutes);

export default router;
