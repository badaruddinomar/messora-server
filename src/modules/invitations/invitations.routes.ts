import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validate } from "../../middlewares/validate.js";
import * as invitations from "./invitations.controller.js";
import { receivedInvitationParams, tokenParams } from "./invitations.schema.js";

/** Invitee-side routes. Mess-side routes (create/list/revoke) live under /messes/:messId/invitations. */
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
