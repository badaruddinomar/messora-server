import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import type { ListBazarsQuery } from "./bazars.schema.js";
import * as bazars from "./bazars.service.js";

const bazarId = (req: Request) => String(req.params.bazarId);

export async function list(req: Request, res: Response) {
  sendResponse(res, {
    data: await bazars.listBazars(membershipOf(req), req.query as unknown as ListBazarsQuery),
  });
}

export async function summary(req: Request, res: Response) {
  const monthId = req.query.monthId ? String(req.query.monthId) : undefined;
  sendResponse(res, { data: await bazars.bazarSummary(membershipOf(req), monthId) });
}

export async function get(req: Request, res: Response) {
  sendResponse(res, { data: await bazars.getBazar(membershipOf(req), bazarId(req)) });
}

export async function create(req: Request, res: Response) {
  const bazar = await bazars.createBazar(membershipOf(req), req.body);
  const message = bazar.status === "APPROVED" ? "Bazar added" : "Bazar sent for approval";
  sendResponse(res, { statusCode: 201, message, data: bazar });
}

export async function update(req: Request, res: Response) {
  sendResponse(res, {
    message: "Bazar updated",
    data: await bazars.updateBazar(membershipOf(req), bazarId(req), req.body),
  });
}

export async function remove(req: Request, res: Response) {
  await bazars.deleteBazar(membershipOf(req), bazarId(req));
  sendResponse(res, { message: "Bazar deleted" });
}

export async function approve(req: Request, res: Response) {
  const bazar = await bazars.reviewBazar(membershipOf(req), bazarId(req), { status: "APPROVED" });
  sendResponse(res, { message: "Bazar approved", data: bazar });
}

export async function reject(req: Request, res: Response) {
  const bazar = await bazars.reviewBazar(membershipOf(req), bazarId(req), {
    status: "REJECTED",
    reason: req.body.reason,
  });
  sendResponse(res, { message: "Bazar rejected", data: bazar });
}
