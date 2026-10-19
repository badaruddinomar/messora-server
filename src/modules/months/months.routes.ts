import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as months from "./months.controller.js";
import { monthParams, setMonthManagerSchema } from "./months.schema.js";

/** /messes/:messId/months */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/", requireMessMember(), months.list);
router.get("/current", requireMessMember(), months.current);
router.get("/:monthId", requireMessMember(), validate({ params: monthParams }), months.get);
router.patch(
  "/:monthId/manager",
  requireMessMember(ADMIN_ONLY),
  validate({ params: monthParams, body: setMonthManagerSchema }),
  months.setManager,
);

export default router;
