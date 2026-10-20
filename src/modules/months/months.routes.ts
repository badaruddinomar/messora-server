import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as months from "./months.controller.js";
import { closeMonthSchema, monthParams, setMonthManagerSchema, statementParams } from "./months.schema.js";

/** /messes/:messId/months */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/", requireMessMember(), months.list);
router.get("/current", requireMessMember(), months.current);
router.get("/:monthId", requireMessMember(), validate({ params: monthParams }), months.get);
router.get("/:monthId/preview", requireMessMember(), validate({ params: monthParams }), months.preview);
router.get(
  "/:monthId/statement/:memberId",
  requireMessMember(),
  validate({ params: statementParams }),
  months.statement,
);

// Closing (BUSINESS_RULES §3, §8).
router.get(
  "/:monthId/close-check",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: monthParams }),
  months.closeCheck,
);
router.post(
  "/:monthId/start-closing",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: monthParams }),
  months.startClosing,
);
router.post(
  "/:monthId/reopen",
  requireMessMember(ADMIN_ONLY),
  validate({ params: monthParams }),
  months.reopen,
);
router.post(
  "/:monthId/close",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: monthParams, body: closeMonthSchema }),
  months.close,
);
router.patch(
  "/:monthId/manager",
  requireMessMember(ADMIN_ONLY),
  validate({ params: monthParams, body: setMonthManagerSchema }),
  months.setManager,
);

export default router;
