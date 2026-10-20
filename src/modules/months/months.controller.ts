import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import * as closing from "./month-close.service.js";
import { getMonthPreview } from "./month-preview.service.js";
import { getStatement } from "./month-statement.service.js";
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

export async function statement(req: Request, res: Response) {
  const membership = membershipOf(req);
  const memberId = req.params.memberId === "me" ? membership.id : String(req.params.memberId);
  sendResponse(res, { data: await getStatement(membership, monthId(req), memberId) });
}

export async function closeCheck(req: Request, res: Response) {
  sendResponse(res, { data: await closing.closeChecks(membershipOf(req), monthId(req)) });
}

export async function startClosing(req: Request, res: Response) {
  const month = await closing.startClosing(membershipOf(req), monthId(req));
  sendResponse(res, { message: "Month is being closed", data: month });
}

export async function reopen(req: Request, res: Response) {
  sendResponse(res, {
    message: "Month reopened",
    data: await closing.reopenMonth(membershipOf(req), monthId(req)),
  });
}

export async function close(req: Request, res: Response) {
  const month = await closing.closeMonth(membershipOf(req), monthId(req), req.body.version);
  sendResponse(res, { message: "Month closed", data: month });
}
