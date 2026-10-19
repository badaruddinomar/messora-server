import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import * as members from "./members.service.js";

const memberId = (req: Request) => String(req.params.memberId);

export async function list(req: Request, res: Response) {
  const { status } = req.query as unknown as { status: Parameters<typeof members.listMembers>[1] };
  sendResponse(res, { data: await members.listMembers(membershipOf(req), status) });
}

export async function join(req: Request, res: Response) {
  const mess = await members.requestToJoin(req.user!.id, req.body.joinCode);
  sendResponse(res, { statusCode: 201, message: "Request sent", data: mess });
}

export async function cancelRequest(req: Request, res: Response) {
  await members.cancelJoinRequest(req.user!.id, String(req.params.messId));
  sendResponse(res, { message: "Request cancelled" });
}

export async function approve(req: Request, res: Response) {
  sendResponse(res, {
    message: "Member approved",
    data: await members.approveMember(membershipOf(req), memberId(req)),
  });
}

export async function reject(req: Request, res: Response) {
  await members.rejectMember(membershipOf(req), memberId(req));
  sendResponse(res, { message: "Request declined" });
}

export async function changeRole(req: Request, res: Response) {
  sendResponse(res, {
    message: "Role updated",
    data: await members.changeRole(membershipOf(req), memberId(req), req.body.role),
  });
}

export async function suspend(req: Request, res: Response) {
  sendResponse(res, {
    message: "Member suspended",
    data: await members.setSuspended(membershipOf(req), memberId(req), true),
  });
}

export async function reactivate(req: Request, res: Response) {
  sendResponse(res, {
    message: "Member reactivated",
    data: await members.setSuspended(membershipOf(req), memberId(req), false),
  });
}

export async function remove(req: Request, res: Response) {
  await members.removeMember(membershipOf(req), memberId(req), req.body?.reason);
  sendResponse(res, { message: "Member removed" });
}

export async function leave(req: Request, res: Response) {
  await members.leaveMess(membershipOf(req), req.body?.reason);
  sendResponse(res, { message: "You left the mess" });
}
