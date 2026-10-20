import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import { getMonthPreview } from "./month-preview.service.js";
import * as months from "./months.service.js";

const monthId = (req: Request) => String(req.params.monthId);

export async function list(req: Request, res: Response) {
  sendResponse(res, { data: await months.listMonths(membershipOf(req)) });
}

export async function current(req: Request, res: Response) {
  sendResponse(res, { data: await months.getCurrentMonth(membershipOf(req)) });
}

export async function get(req: Request, res: Response) {
  sendResponse(res, { data: await months.getMonth(membershipOf(req), monthId(req)) });
}

export async function setManager(req: Request, res: Response) {
  const month = await months.setMonthManager(membershipOf(req), monthId(req), req.body.managerId);
  sendResponse(res, { message: "Month manager updated", data: month });
}

export async function preview(req: Request, res: Response) {
  sendResponse(res, { data: await getMonthPreview(membershipOf(req), monthId(req)) });
}
