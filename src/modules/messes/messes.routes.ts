import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { strictLimiter } from "../../middlewares/rate-limit.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as members from "../members/members.controller.js";
import { joinMessSchema, leaveMessSchema } from "../members/members.schema.js";
import * as messes from "./messes.controller.js";
import {
  createMessSchema,
  deleteMessSchema,
  messIdParams,
  updateMessSchema,
  updateSettingsSchema,
} from "./messes.schema.js";

/**
 * /messes — the mess itself. Feature modules inside a mess (members, invitations, months, …) have
 * their own routers mounted at /messes/:messId/<module> in routes/index.ts.
 */
const router = Router();
router.use(requireAuth);

const member = requireMessMember();
const manager = requireMessMember(MANAGER_ACCESS);
const admin = requireMessMember(ADMIN_ONLY);

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

export default router;
