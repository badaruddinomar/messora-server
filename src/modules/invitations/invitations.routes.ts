import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { strictLimiter } from "../../middlewares/rate-limit.js";
import { MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as invitations from "./invitations.controller.js";
import {
  createInvitationSchema,
  invitationIdParams,
  receivedInvitationParams,
  tokenParams,
} from "./invitations.schema.js";

/** /messes/:messId/invitations: a mess's managers create, list and revoke invitations. */
export const messInvitationRoutes = Router({ mergeParams: true });
messInvitationRoutes.use(requireAuth, requireMessMember(MANAGER_ACCESS));
messInvitationRoutes.get("/", invitations.list);
messInvitationRoutes.post("/", strictLimiter, validate({ body: createInvitationSchema }), invitations.create);
messInvitationRoutes.delete("/:invitationId", validate({ params: invitationIdParams }), invitations.revoke);

/** /invitations: the invitee's side. */
const router = Router();

// Invitations sent to the logged-in user's phone or email.
router.get("/received", requireAuth, invitations.listReceived);
router.post(
  "/received/:invitationId/accept",
  requireAuth,
  validate({ params: receivedInvitationParams }),
  invitations.acceptReceived,
);
router.post(
  "/received/:invitationId/decline",
  requireAuth,
  validate({ params: receivedInvitationParams }),
  invitations.declineReceived,
);

// Invitation links. The preview is public so the page can show the invite before login.
router.get("/:token", validate({ params: tokenParams }), invitations.preview);
router.post("/:token/accept", requireAuth, validate({ params: tokenParams }), invitations.acceptByToken);
router.post("/:token/decline", requireAuth, validate({ params: tokenParams }), invitations.declineByToken);

export default router;
