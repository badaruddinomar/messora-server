import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import * as messes from "./messes.service.js";

export async function create(req: Request, res: Response) {
  const mess = await messes.createMess(req.user!.id, req.body);
  sendResponse(res, { statusCode: 201, message: "Mess created", data: mess });
}

export async function listMine(req: Request, res: Response) {
  sendResponse(res, { data: await messes.listMyMesses(req.user!.id) });
}

export async function get(req: Request, res: Response) {
  sendResponse(res, { data: await messes.getMess(membershipOf(req)) });
}

export async function update(req: Request, res: Response) {
  sendResponse(res, { message: "Mess updated", data: await messes.updateMess(membershipOf(req), req.body) });
}

export async function remove(req: Request, res: Response) {
  await messes.deleteMess(membershipOf(req), req.body.confirmName);
  sendResponse(res, { message: "Mess deleted" });
}

export async function regenerateJoinCode(req: Request, res: Response) {
  sendResponse(res, {
    message: "Join code changed",
    data: await messes.regenerateJoinCode(membershipOf(req)),
  });
}

export async function getSettings(req: Request, res: Response) {
  sendResponse(res, { data: await messes.getSettings(membershipOf(req).messId) });
}

export async function updateSettings(req: Request, res: Response) {
  sendResponse(res, {
    message: "Settings saved",
    data: await messes.updateSettings(membershipOf(req), req.body),
  });
}
