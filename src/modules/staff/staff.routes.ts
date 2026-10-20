import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import { staffParams, staffSchema, updateStaffSchema } from "./staff.schema.js";
import * as staff from "./staff.service.js";

const staffId = (req: Request) => String(req.params.staffId);

/** /messes/:messId/staff — admins manage staff (BUSINESS_RULES §2); paying them is an expense (managers). */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  requireMessMember(),
  validate({ query: z.object({ monthId: z.uuid().optional() }) }),
  async (req: Request, res: Response) => {
    const monthId = req.query.monthId ? String(req.query.monthId) : undefined;
    sendResponse(res, { data: await staff.listStaff(membershipOf(req), monthId) });
  },
);
router.post(
  "/",
  requireMessMember(ADMIN_ONLY),
  validate({ body: staffSchema }),
  async (req: Request, res: Response) => {
    sendResponse(res, {
      statusCode: 201,
      message: "Staff added",
      data: await staff.createStaff(membershipOf(req), req.body),
    });
  },
);
router.patch(
  "/:staffId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: staffParams, body: updateStaffSchema }),
  async (req: Request, res: Response) => {
    const data = await staff.updateStaff(membershipOf(req), staffId(req), req.body);
    sendResponse(res, { message: "Staff updated", data });
  },
);
router.delete(
  "/:staffId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: staffParams }),
  async (req: Request, res: Response) => {
    const data = await staff.deleteStaff(membershipOf(req), staffId(req));
    sendResponse(res, { message: data.deactivated ? "Staff marked inactive" : "Staff removed", data });
  },
);

export default router;
