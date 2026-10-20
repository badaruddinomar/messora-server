import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import { chargeParams, createChargeSchema, listChargesQuery, updateChargeSchema } from "./charges.schema.js";
import * as charges from "./charges.service.js";

const chargeId = (req: Request) => String(req.params.chargeId);

/** /messes/:messId/charges */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  requireMessMember(),
  validate({ query: listChargesQuery }),
  async (req: Request, res: Response) => {
    const query = req.query as { monthId?: string; memberId?: string };
    sendResponse(res, { data: await charges.listCharges(membershipOf(req), query) });
  },
);
router.post(
  "/",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: createChargeSchema }),
  async (req: Request, res: Response) => {
    const data = await charges.createCharge(membershipOf(req), req.body);
    sendResponse(res, { statusCode: 201, message: "Charge added", data });
  },
);
router.patch(
  "/:chargeId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: chargeParams, body: updateChargeSchema }),
  async (req: Request, res: Response) => {
    const data = await charges.updateCharge(membershipOf(req), chargeId(req), req.body);
    sendResponse(res, { message: "Charge updated", data });
  },
);
router.delete(
  "/:chargeId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: chargeParams }),
  async (req: Request, res: Response) => {
    await charges.deleteCharge(membershipOf(req), chargeId(req));
    sendResponse(res, { message: "Charge removed" });
  },
);

export default router;
