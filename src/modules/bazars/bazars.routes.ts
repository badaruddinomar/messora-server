import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as bazars from "./bazars.controller.js";
import {
  bazarParams,
  createBazarSchema,
  listBazarsQuery,
  rejectBazarSchema,
  summaryQuery,
  updateBazarSchema,
} from "./bazars.schema.js";

/** /messes/:messId/bazars — edit and delete permissions are checked per bazar in the service. */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/", requireMessMember(), validate({ query: listBazarsQuery }), bazars.list);
router.get("/summary", requireMessMember(), validate({ query: summaryQuery }), bazars.summary);
router.post("/", requireMessMember(), validate({ body: createBazarSchema }), bazars.create);
router.get("/:bazarId", requireMessMember(), validate({ params: bazarParams }), bazars.get);
router.patch(
  "/:bazarId",
  requireMessMember(),
  validate({ params: bazarParams, body: updateBazarSchema }),
  bazars.update,
);
router.delete("/:bazarId", requireMessMember(), validate({ params: bazarParams }), bazars.remove);
router.post(
  "/:bazarId/approve",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: bazarParams }),
  bazars.approve,
);
router.post(
  "/:bazarId/reject",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: bazarParams, body: rejectBazarSchema }),
  bazars.reject,
);

export default router;
