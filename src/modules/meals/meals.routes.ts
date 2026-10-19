import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middlewares/auth.js";
import { ADMIN_ONLY, MANAGER_ACCESS, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import * as meals from "./meals.controller.js";
import {
  createOffPeriodSchema,
  createRequestSchema,
  createSlotSchema,
  dayQuery,
  listOffPeriodsQuery,
  listRequestsQuery,
  menuParams,
  offPeriodParams,
  preferenceSchema,
  rangeQuery,
  requestParams,
  respondRequestSchema,
  slotParams,
  updateSlotSchema,
  upsertEntriesSchema,
  upsertMenuSchema,
} from "./meals.schema.js";

const memberParams = z.object({ messId: z.uuid(), memberId: z.union([z.literal("me"), z.uuid()]) });

/** /messes/:messId/meals */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/day", requireMessMember(), validate({ query: dayQuery }), meals.day);
router.get(
  "/members/:memberId",
  requireMessMember(),
  validate({ params: memberParams, query: rangeQuery }),
  meals.memberMeals,
);
// Permissions per entry are checked in the service (own meals before cutoff vs. managers).
router.put("/", requireMessMember(), validate({ body: upsertEntriesSchema }), meals.upsert);
router.patch("/preference", requireMessMember(), validate({ body: preferenceSchema }), meals.setPreference);

router.get("/off", requireMessMember(), validate({ query: listOffPeriodsQuery }), meals.listOffPeriods);
router.post("/off", requireMessMember(), validate({ body: createOffPeriodSchema }), meals.createOffPeriod);
router.delete(
  "/off/:periodId",
  requireMessMember(),
  validate({ params: offPeriodParams }),
  meals.deleteOffPeriod,
);

router.get("/requests", requireMessMember(), validate({ query: listRequestsQuery }), meals.listRequests);
router.post("/requests", requireMessMember(), validate({ body: createRequestSchema }), meals.createRequest);
router.patch(
  "/requests/:requestId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: requestParams, body: respondRequestSchema }),
  meals.respondToRequest,
);
router.delete(
  "/requests/:requestId",
  requireMessMember(),
  validate({ params: requestParams }),
  meals.cancelRequest,
);

router.get("/menu", requireMessMember(), validate({ query: rangeQuery }), meals.listMenu);
router.put(
  "/menu",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: upsertMenuSchema }),
  meals.upsertMenu,
);
router.delete(
  "/menu/:menuId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: menuParams }),
  meals.deleteMenu,
);

export default router;

/** /messes/:messId/meal-slots */
export const mealSlotRoutes = Router({ mergeParams: true });
mealSlotRoutes.use(requireAuth);

mealSlotRoutes.get("/", requireMessMember(), meals.listSlots);
mealSlotRoutes.post(
  "/",
  requireMessMember(ADMIN_ONLY),
  validate({ body: createSlotSchema }),
  meals.createSlot,
);
mealSlotRoutes.patch(
  "/:slotId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: slotParams, body: updateSlotSchema }),
  meals.updateSlot,
);
mealSlotRoutes.delete(
  "/:slotId",
  requireMessMember(ADMIN_ONLY),
  validate({ params: slotParams }),
  meals.deleteSlot,
);
