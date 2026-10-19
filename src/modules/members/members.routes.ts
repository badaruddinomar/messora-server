import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as members from "./members.controller.js";
import { changeRoleSchema, listMembersQuery, memberParams, removeMemberSchema } from "./members.schema.js";

/** /messes/:messId/members */
const router = Router({ mergeParams: true });
router.use(requireAuth);

const manager = requireMessMember(MANAGER_ACCESS);
const admin = requireMessMember(ADMIN_ONLY);

router.get("/", requireMessMember(), validate({ query: listMembersQuery }), members.list);
router.post("/:memberId/approve", manager, validate({ params: memberParams }), members.approve);
router.post("/:memberId/reject", manager, validate({ params: memberParams }), members.reject);
router.patch(
  "/:memberId/role",
  admin,
  validate({ params: memberParams, body: changeRoleSchema }),
  members.changeRole,
);
router.post("/:memberId/suspend", admin, validate({ params: memberParams }), members.suspend);
router.post("/:memberId/reactivate", admin, validate({ params: memberParams }), members.reactivate);
router.delete(
  "/:memberId",
  admin,
  validate({ params: memberParams, body: removeMemberSchema }),
  members.remove,
);

export default router;
