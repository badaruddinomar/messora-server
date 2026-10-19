import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes.js";
import invitationRoutes, { messInvitationRoutes } from "../modules/invitations/invitations.routes.js";
import memberRoutes from "../modules/members/members.routes.js";
import messRoutes from "../modules/messes/messes.routes.js";
import monthRoutes from "../modules/months/months.routes.js";

/** Mounts every feature module under the API prefix. */
const router = Router();

router.use("/auth", authRoutes);
router.use("/invitations", invitationRoutes);

// Mess-scoped modules first, so their paths don't fall through the /messes router.
router.use("/messes/:messId/members", memberRoutes);
router.use("/messes/:messId/invitations", messInvitationRoutes);
router.use("/messes/:messId/months", monthRoutes);
router.use("/messes", messRoutes);

export default router;
