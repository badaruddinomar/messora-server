import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import * as plans from "./meal-plans.service.js";
import * as requests from "./meal-requests.service.js";
import * as slots from "./meal-slots.service.js";
import type { ListOffPeriodsQuery, ListRequestsQuery } from "./meals.schema.js";
import * as meals from "./meals.service.js";
import * as menu from "./menu.service.js";

const param = (req: Request, name: string) => String(req.params[name]);

// ---------- slots ----------

export async function listSlots(req: Request, res: Response) {
  sendResponse(res, { data: await slots.listSlots(membershipOf(req).messId) });
}

export async function createSlot(req: Request, res: Response) {
  sendResponse(res, {
    statusCode: 201,
    message: "Meal added",
    data: await slots.createSlot(membershipOf(req), req.body),
  });
}

export async function updateSlot(req: Request, res: Response) {
  const slot = await slots.updateSlot(membershipOf(req), param(req, "slotId"), req.body);
  sendResponse(res, { message: "Meal updated", data: slot });
}

export async function deleteSlot(req: Request, res: Response) {
  const result = await slots.deleteSlot(membershipOf(req), param(req, "slotId"));
  sendResponse(res, { message: result.archived ? "Meal archived" : "Meal removed", data: result });
}

// ---------- entries ----------

export async function day(req: Request, res: Response) {
  sendResponse(res, { data: await meals.getDay(membershipOf(req), String(req.query.date)) });
}

export async function memberMeals(req: Request, res: Response) {
  const membership = membershipOf(req);
  const memberId = param(req, "memberId") === "me" ? membership.id : param(req, "memberId");
  const data = await meals.getMemberMeals(membership, memberId, String(req.query.from), String(req.query.to));
  sendResponse(res, { data });
}

export async function upsert(req: Request, res: Response) {
  sendResponse(res, { message: "Meals saved", data: await meals.upsertEntries(membershipOf(req), req.body) });
}

// ---------- plans ----------

export async function setPreference(req: Request, res: Response) {
  const result = await plans.setDefaultMeal(membershipOf(req), req.body);
  sendResponse(res, {
    message: result.defaultMealOn ? "Usual meals turned on" : "Usual meals turned off",
    data: result,
  });
}

export async function listOffPeriods(req: Request, res: Response) {
  const query = req.query as unknown as ListOffPeriodsQuery;
  sendResponse(res, { data: await plans.listOffPeriods(membershipOf(req), query) });
}

export async function createOffPeriod(req: Request, res: Response) {
  const period = await plans.createOffPeriod(membershipOf(req), req.body);
  sendResponse(res, { statusCode: 201, message: "Meals turned off for those days", data: period });
}

export async function deleteOffPeriod(req: Request, res: Response) {
  const result = await plans.deleteOffPeriod(membershipOf(req), param(req, "periodId"));
  sendResponse(res, { message: result.ended ? "Meal-off ended" : "Meal-off cancelled", data: result });
}

// ---------- requests ----------

export async function listRequests(req: Request, res: Response) {
  const query = req.query as unknown as ListRequestsQuery;
  sendResponse(res, { data: await requests.listRequests(membershipOf(req), query) });
}

export async function createRequest(req: Request, res: Response) {
  const created = await requests.createRequest(membershipOf(req), req.body);
  sendResponse(res, { statusCode: 201, message: "Request sent to the managers", data: created });
}

export async function respondToRequest(req: Request, res: Response) {
  const updated = await requests.respondToRequest(membershipOf(req), param(req, "requestId"), req.body);
  sendResponse(res, { message: "Response sent", data: updated });
}

export async function cancelRequest(req: Request, res: Response) {
  await requests.cancelRequest(membershipOf(req), param(req, "requestId"));
  sendResponse(res, { message: "Request withdrawn" });
}

// ---------- menu ----------

export async function listMenu(req: Request, res: Response) {
  const data = await menu.listMenu(membershipOf(req).messId, String(req.query.from), String(req.query.to));
  sendResponse(res, { data });
}

export async function upsertMenu(req: Request, res: Response) {
  sendResponse(res, { message: "Menu posted", data: await menu.upsertMenu(membershipOf(req), req.body) });
}

export async function deleteMenu(req: Request, res: Response) {
  await menu.deleteMenu(membershipOf(req), param(req, "menuId"));
  sendResponse(res, { message: "Menu removed" });
}
