import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import {
  assignSeatSchema,
  roomParams,
  roomSchema,
  seatParams,
  seatSchema,
  updateRoomSchema,
  updateSeatSchema,
} from "./rooms.schema.js";
import * as rooms from "./rooms.service.js";

const param = (req: Request, name: string) => String(req.params[name]);

/** /messes/:messId/rooms — everyone sees the board; admins change it (BUSINESS_RULES §2). */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/", requireMessMember(), async (req: Request, res: Response) => {
  sendResponse(res, { data: await rooms.listRooms(membershipOf(req).messId) });
});

// Seat routes first, so "/seats/…" never matches "/:roomId".
router.patch(
  "/seats/:seatId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: seatParams, body: updateSeatSchema }),
  async (req: Request, res: Response) => {
    const data = await rooms.updateSeat(membershipOf(req), param(req, "seatId"), req.body);
    sendResponse(res, { message: "Seat updated", data });
  },
);
router.delete(
  "/seats/:seatId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: seatParams }),
  async (req: Request, res: Response) => {
    await rooms.deleteSeat(membershipOf(req), param(req, "seatId"));
    sendResponse(res, { message: "Seat removed" });
  },
);
router.put(
  "/seats/:seatId/member",
  requireMessMember(ADMIN_ONLY),
  validate({ params: seatParams, body: assignSeatSchema }),
  async (req: Request, res: Response) => {
    const data = await rooms.assignSeat(membershipOf(req), param(req, "seatId"), req.body.memberId);
    sendResponse(res, {
      message: data.member ? `${data.member.name} is in ${data.label}` : "Seat emptied",
      data,
    });
  },
);

router.post(
  "/",
  requireMessMember(ADMIN_ONLY),
  validate({ body: roomSchema }),
  async (req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: 201,
      message: "Room added",
      data: await rooms.createRoom(membershipOf(req), req.body),
    });
  },
);
router.patch(
  "/:roomId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: roomParams, body: updateRoomSchema }),
  async (req: Request, res: Response) => {
    const data = await rooms.updateRoom(membershipOf(req), param(req, "roomId"), req.body);
    sendResponse(res, { message: "Room updated", data });
  },
);
router.delete(
  "/:roomId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: roomParams }),
  async (req: Request, res: Response) => {
    await rooms.deleteRoom(membershipOf(req), param(req, "roomId"));
    sendResponse(res, { message: "Room removed" });
  },
);
router.post(
  "/:roomId/seats",
  requireMessMember(ADMIN_ONLY),
  validate({ params: roomParams, body: seatSchema }),
  async (req: Request, res: Response) => {
    const data = await rooms.createSeat(membershipOf(req), param(req, "roomId"), req.body);
    sendResponse(res, { statusCode: 201, message: "Seat added", data });
  },
);

export default router;
