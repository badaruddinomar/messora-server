import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { MANAGER_ACCESS, membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import {
  createExpenseSchema,
  expenseParams,
  expenseSummaryQuery,
  listExpensesQuery,
  payStaffSchema,
  splitPreviewSchema,
  updateExpenseSchema,
  type ListExpensesQuery,
} from "./expenses.schema.js";
import * as expenses from "./expenses.service.js";

const expenseId = (req: Request) => String(req.params.expenseId);

/** /messes/:messId/expenses — everyone sees shared costs; managers add them (BUSINESS_RULES §2). */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get(
  "/",
  requireMessMember(),
  validate({ query: listExpensesQuery }),
  async (req: Request, res: Response) => {
    const data = await expenses.listExpenses(membershipOf(req), req.query as unknown as ListExpensesQuery);
    sendResponse(res, { data });
  },
);
router.get(
  "/summary",
  requireMessMember(),
  validate({ query: expenseSummaryQuery }),
  async (req: Request, res: Response) => {
    const monthId = req.query.monthId ? String(req.query.monthId) : undefined;
    sendResponse(res, { data: await expenses.expenseSummary(membershipOf(req), monthId) });
  },
);
router.post(
  "/split-preview",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: splitPreviewSchema }),
  async (req: Request, res: Response) => {
    sendResponse(res, { data: await expenses.previewSplit(membershipOf(req), req.body) });
  },
);
router.post(
  "/pay-staff",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: payStaffSchema }),
  async (req: Request, res: Response) => {
    const data = await expenses.payStaff(membershipOf(req), req.body);
    sendResponse(res, { statusCode: 201, message: "Salary recorded", data });
  },
);
router.post(
  "/",
  requireMessMember(MANAGER_ACCESS),
  validate({ body: createExpenseSchema }),
  async (req: Request, res: Response) => {
    const data = await expenses.createExpense(membershipOf(req), req.body);
    sendResponse(res, { statusCode: 201, message: "Expense added", data });
  },
);
router.get(
  "/:expenseId",
  requireMessMember(),
  validate({ params: expenseParams }),
  async (req: Request, res: Response) => {
    sendResponse(res, { data: await expenses.getExpense(membershipOf(req), expenseId(req)) });
  },
);
router.patch(
  "/:expenseId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: expenseParams, body: updateExpenseSchema }),
  async (req: Request, res: Response) => {
    const data = await expenses.updateExpense(membershipOf(req), expenseId(req), req.body);
    sendResponse(res, { message: "Expense updated", data });
  },
);
router.delete(
  "/:expenseId",
  requireMessMember(MANAGER_ACCESS),
  validate({ params: expenseParams }),
  async (req: Request, res: Response) => {
    await expenses.deleteExpense(membershipOf(req), expenseId(req));
    sendResponse(res, { message: "Expense deleted" });
  },
);

export default router;
