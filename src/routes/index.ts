import { Router } from "express";
import authRoutes from "../modules/auth/auth.routes.js";
import bazarRoutes from "../modules/bazars/bazars.routes.js";
import bazarDutyRoutes from "../modules/bazars/duties.routes.js";
import invitationRoutes, { messInvitationRoutes } from "../modules/invitations/invitations.routes.js";
import mealRoutes, { mealSlotRoutes } from "../modules/meals/meals.routes.js";
import memberRoutes from "../modules/members/members.routes.js";
import messRoutes from "../modules/messes/messes.routes.js";
import { localFileRoutes, messUploadRoutes, serveLocalFiles } from "../modules/uploads/uploads.routes.js";
import monthRoutes from "../modules/months/months.routes.js";

/** Mounts every feature module under the API prefix. */
const router = Router();

router.use("/auth", authRoutes);
router.use("/invitations", invitationRoutes);
if (serveLocalFiles) router.use("/files", localFileRoutes);

// Mess-scoped modules first, so their paths don't fall through the /messes router.
router.use("/messes/:messId/members", memberRoutes);
router.use("/messes/:messId/invitations", messInvitationRoutes);
router.use("/messes/:messId/months", monthRoutes);
router.use("/messes/:messId/meals", mealRoutes);
router.use("/messes/:messId/meal-slots", mealSlotRoutes);
router.use("/messes/:messId/uploads", messUploadRoutes);
router.use("/messes/:messId/bazars", bazarRoutes);
router.use("/messes/:messId/bazar-duties", bazarDutyRoutes);
router.use("/messes", messRoutes);

export default router;
