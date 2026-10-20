import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import * as handovers from "./handover.service.js";
import {
  createHandoverSchema,
  handoverParams,
  listSettlementsQuery,
  recordSettlementSchema,
  respondHandoverSchema,
  settlementParams,
} from "./settlement.schema.js";
import * as settlements from "./settlements.service.js";

const monthParams = z.object({ messId: z.uuid(), monthId: z.uuid() });
const param = (req: Request, name: string) => String(req.params[name]);

/** /messes/:messId/months/:monthId/settlements and /handovers (a closed month's money). */
export const monthSettlementRoutes = Router({ mergeParams: true });
monthSettlementRoutes.use(requireAuth);

monthSettlementRoutes.get(
  "/settlements",
  requireMessMember(),
  validate({ params: monthParams, query: listSettlementsQuery }),
  async (req: Request, res: Response) => {
    const status = req.query.status as "settled" | "unsettled" | undefined;
    sendResponse(res, {
      data: await settlements.listSettlements(membershipOf(req), param(req, "monthId"), status),
    });
  },
);
monthSettlementRoutes.post(
  "/settlements",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: monthParams, body: recordSettlementSchema }),
  async (req: Request, res: Response) => {
    const data = await settlements.recordSettlement(membershipOf(req), param(req, "monthId"), req.body);
    sendResponse(res, { statusCode: 201, message: "Payment recorded", data });
  },
);
monthSettlementRoutes.get(
  "/handovers",
  requireMessMember(),
  validate({ params: monthParams }),
  async (req: Request, res: Response) => {
    sendResponse(res, { data: await handovers.listHandovers(membershipOf(req), param(req, "monthId")) });
  },
);
monthSettlementRoutes.post(
  "/handovers",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: monthParams, body: createHandoverSchema }),
  async (req: Request, res: Response) => {
    const data = await handovers.createHandover(membershipOf(req), param(req, "monthId"), req.body);
    sendResponse(res, { statusCode: 201, message: "Cash handed over", data });
  },
);

/** /messes/:messId/settlements/:id and /messes/:messId/handovers/:id */
export const settlementRoutes = Router({ mergeParams: true });
settlementRoutes.use(requireAuth);

settlementRoutes.delete(
  "/settlements/:settlementId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: settlementParams }),
  async (req: Request, res: Response) => {
    await settlements.deleteSettlement(membershipOf(req), param(req, "settlementId"));
    sendResponse(res, { message: "Payment removed" });
  },
);
settlementRoutes.post(
  "/handovers/:handoverId/respond",
  requireMessMember(),
  validate({ params: handoverParams, body: respondHandoverSchema }),
  async (req: Request, res: Response) => {
    const data = await handovers.respondToHandover(membershipOf(req), param(req, "handoverId"), req.body);
    sendResponse(res, { message: data.status === "CONFIRMED" ? "Cash confirmed" : "Cash disputed", data });
  },
);
