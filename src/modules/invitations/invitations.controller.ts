import type { Request, Response } from "express";
import { membershipOf } from "../../middlewares/tenant.js";
import { sendResponse } from "../../utils/send-response.js";
import * as invitations from "./invitations.service.js";

export async function create(req: Request, res: Response) {
  const result = await invitations.createInvitation(membershipOf(req), req.body);
  sendResponse(res, { statusCode: 201, message: "Invitation created", data: result });
}

export async function list(req: Request, res: Response) {
  sendResponse(res, { data: await invitations.listInvitations(membershipOf(req)) });
}

export async function revoke(req: Request, res: Response) {
  await invitations.revokeInvitation(membershipOf(req), String(req.params.invitationId));
  sendResponse(res, { message: "Invitation revoked" });
}

export async function preview(req: Request, res: Response) {
  sendResponse(res, { data: await invitations.previewInvitation(String(req.params.token)) });
}

export async function acceptByToken(req: Request, res: Response) {
  const mess = await invitations.acceptByToken(req.user!.id, String(req.params.token));
  sendResponse(res, { message: "Welcome to the mess", data: mess });
}

export async function declineByToken(req: Request, res: Response) {
  await invitations.declineByToken(String(req.params.token));
  sendResponse(res, { message: "Invitation declined" });
}

export async function listReceived(req: Request, res: Response) {
  sendResponse(res, { data: await invitations.listReceivedInvitations(req.user!.id) });
}

export async function acceptReceived(req: Request, res: Response) {
  const mess = await invitations.acceptById(req.user!.id, String(req.params.invitationId));
  sendResponse(res, { message: "Welcome to the mess", data: mess });
}

export async function declineReceived(req: Request, res: Response) {
  await invitations.declineById(req.user!.id, String(req.params.invitationId));
  sendResponse(res, { message: "Invitation declined" });
}
