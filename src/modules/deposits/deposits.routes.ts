import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import {
  createDepositSchema,
  depositParams,
  listDepositsQuery,
  rejectDepositSchema,
  summaryQuery,
  updateDepositSchema,
  type ListDepositsQuery,
} from "./deposits.schema.js";
import * as deposits from "./deposits.service.js";

const depositId = (req: Request) => String(req.params.depositId);

/** /messes/:messId/deposits — who may see or change a deposit is checked per deposit in the service. */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  requireMessMember(),
  validate({ query: listDepositsQuery }),
  async (req: Request, res: Response) => {
    const data = await deposits.listDeposits(membershipOf(req), req.query as unknown as ListDepositsQuery);
    sendResponse(res, { data });
  },
);

router.get(
  "/summary",
  requireMessMember(),
  validate({ query: summaryQuery }),
  async (req: Request, res: Response) => {
    const monthId = req.query.monthId ? String(req.query.monthId) : undefined;
    sendResponse(res, { data: await deposits.depositSummary(membershipOf(req), monthId) });
  },
);

router.post(
  "/",
  requireMessMember(),
  validate({ body: createDepositSchema }),
  async (req: Request, res: Response) => {
    const deposit = await deposits.createDeposit(membershipOf(req), req.body);
    const message = deposit.status === "APPROVED" ? "Deposit recorded" : "Deposit sent for confirmation";
    sendResponse(res, { statusCode: 201, message, data: deposit });
  },
);

router.get(
  "/:depositId",
  requireMessMember(),
  validate({ params: depositParams }),
  async (req: Request, res: Response) => {
    sendResponse(res, { data: await deposits.getDeposit(membershipOf(req), depositId(req)) });
  },
);

router.patch(
  "/:depositId",
  requireMessMember(),
  validate({ params: depositParams, body: updateDepositSchema }),
  async (req: Request, res: Response) => {
    const data = await deposits.updateDeposit(membershipOf(req), depositId(req), req.body);
    sendResponse(res, { message: "Deposit updated", data });
  },
);

router.delete(
  "/:depositId",
  requireMessMember(),
  validate({ params: depositParams }),
  async (req: Request, res: Response) => {
    await deposits.deleteDeposit(membershipOf(req), depositId(req));
    sendResponse(res, { message: "Deposit deleted" });
  },
);

router.post(
  "/:depositId/approve",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: depositParams }),
  async (req: Request, res: Response) => {
    const data = await deposits.reviewDeposit(membershipOf(req), depositId(req), { status: "APPROVED" });
    sendResponse(res, { message: "Deposit confirmed", data });
  },
);

router.post(
  "/:depositId/reject",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: depositParams, body: rejectDepositSchema }),
  async (req: Request, res: Response) => {
    const data = await deposits.reviewDeposit(membershipOf(req), depositId(req), {
      status: "REJECTED",
      reason: req.body.reason,
    });
    sendResponse(res, { message: "Deposit rejected", data });
  },
);

export default router;
