import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import {
  createDutySchema,
  dutiesQuery,
  dutyParams,
  generateDutiesSchema,
  swapDutiesSchema,
  updateDutySchema,
} from "./duties.schema.js";
import * as duties from "./duties.service.js";

const dutyId = (req: Request) => String(req.params.dutyId);

/** /messes/:messId/bazar-duties */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  requireMessMember(),
  validate({ query: dutiesQuery }),
  async (req: Request, res: Response) => {
    const monthId = req.query.monthId ? String(req.query.monthId) : undefined;
    sendResponse(res, { data: await duties.listDuties(membershipOf(req), monthId) });
  },
);

router.post(
  "/generate",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: generateDutiesSchema }),
  async (req: Request, res: Response) => {
    sendResponse(res, {
      message: "Bazar duty planned",
      data: await duties.generateDuties(membershipOf(req), req.body),
    });
  },
);

router.post(
  "/swap",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: swapDutiesSchema }),
  async (req: Request, res: Response) => {
    const data = await duties.swapDuties(membershipOf(req), req.body.dutyId, req.body.otherDutyId);
    sendResponse(res, { message: "Bazar duty swapped", data });
  },
);

router.post(
  "/",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: createDutySchema }),
  async (req: Request, res: Response) => {
    const data = await duties.createDuty(membershipOf(req), req.body);
    sendResponse(res, { statusCode: 201, message: "Bazar duty added", data });
  },
);

// Members can tick off their own duty; moving or reassigning is checked as manager-only in the service.
router.patch(
  "/:dutyId",
  requireMessMember(),
  validate({ params: dutyParams, body: updateDutySchema }),
  async (req: Request, res: Response) => {
    sendResponse(res, {
      message: "Bazar duty updated",
      data: await duties.updateDuty(membershipOf(req), dutyId(req), req.body),
    });
  },
);

router.delete(
  "/:dutyId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: dutyParams }),
  async (req: Request, res: Response) => {
    await duties.deleteDuty(membershipOf(req), dutyId(req));
    sendResponse(res, { message: "Bazar duty removed" });
  },
);

export default router;
