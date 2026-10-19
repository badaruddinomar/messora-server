import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { strictLimiter } from "../../middlewares/rate-limit.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as invitations from "../invitations/invitations.controller.js";
import { createInvitationSchema, invitationIdParams } from "../invitations/invitations.schema.js";
import * as members from "../members/members.controller.js";
import {
  changeRoleSchema,
  joinMessSchema,
  leaveMessSchema,
  listMembersQuery,
  memberParams,
  removeMemberSchema,
} from "../members/members.schema.js";
import * as messes from "./messes.controller.js";
import {
  createMessSchema,
  deleteMessSchema,
  messIdParams,
  updateMessSchema,
  updateSettingsSchema,
} from "./messes.schema.js";

const router = Router();
router.use(requireAuth);

const member = requireMessMember();
const manager = requireMessMember(MANAGER_ACCESS);
const admin = requireMessMember(ADMIN_ONLY);

// Messes
router.get("/", messes.listMine);
router.post("/", validate({ body: createMessSchema }), messes.create);
router.post("/join", strictLimiter, validate({ body: joinMessSchema }), members.join);
router.delete("/:messId/join-request", validate({ params: messIdParams }), members.cancelRequest);

router.get("/:messId", member, messes.get);
router.patch("/:messId", admin, validate({ body: updateMessSchema }), messes.update);
router.delete("/:messId", admin, validate({ body: deleteMessSchema }), messes.remove);
router.post("/:messId/join-code", manager, messes.regenerateJoinCode);
router.get("/:messId/settings", member, messes.getSettings);
router.patch("/:messId/settings", admin, validate({ body: updateSettingsSchema }), messes.updateSettings);
router.post("/:messId/leave", member, validate({ body: leaveMessSchema }), members.leave);

// Members
router.get("/:messId/members", member, validate({ query: listMembersQuery }), members.list);
router.post(
  "/:messId/members/:memberId/approve",
  manager,
  validate({ params: memberParams }),
  members.approve,
);
router.post("/:messId/members/:memberId/reject", manager, validate({ params: memberParams }), members.reject);
router.patch(
  "/:messId/members/:memberId/role",
  admin,
  validate({ params: memberParams, body: changeRoleSchema }),
  members.changeRole,
);
router.post("/:messId/members/:memberId/suspend", admin, validate({ params: memberParams }), members.suspend);
router.post(
  "/:messId/members/:memberId/reactivate",
  admin,
  validate({ params: memberParams }),
  members.reactivate,
);
router.delete(
  "/:messId/members/:memberId",
  admin,
  validate({ params: memberParams, body: removeMemberSchema }),
  members.remove,
);

// Invitations (mess side)
router.get("/:messId/invitations", manager, invitations.list);
router.post(
  "/:messId/invitations",
  manager,
  strictLimiter,
  validate({ body: createInvitationSchema }),
  invitations.create,
);
router.delete(
  "/:messId/invitations/:invitationId",
  manager,
  validate({ params: invitationIdParams }),
  invitations.revoke,
);

export default router;
