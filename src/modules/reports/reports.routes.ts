import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { membershipOf, requireMessMember } from "../../middlewares/tenant.js";
import { validate } from "../../middlewares/validate.js";
import { sendResponse } from "../../utils/send-response.js";
import { getDashboard } from "./dashboard.service.js";
import {
  exportParams,
  messParams,
  monthParams,
  statementExportParams,
  trendsQuery,
} from "./reports.schema.js";
import * as reports from "./reports.service.js";

const param = (req: Request, name: string) => String(req.params[name]);

function sendCsv(res: Response, file: reports.CsvFile) {
  res
    .status(200)
    .type("text/csv; charset=utf-8")
    .set("Content-Disposition", `attachment; filename="${file.filename}"`)
    .set("Cache-Control", "private, no-store")
    .send(file.body);
}

/**
 * /messes/:messId: the dashboard, trend charts, month reports and CSV exports. Everyone in the
 * mess can see the month's bill (BUSINESS_RULES §2); a member statement follows the statement rule.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);

router.get("/dashboard", requireMessMember(), validate({ params: messParams }), async (req, res) => {
  sendResponse(res, { data: await getDashboard(membershipOf(req)) });
});

router.get(
  "/reports/trends",
  requireMessMember(),
  validate({ params: messParams, query: trendsQuery }),
  async (req, res) => {
    const months = Number(req.query.months);
    sendResponse(res, { data: await reports.getTrends(membershipOf(req), months) });
  },
);

router.get(
  "/months/:monthId/report",
  requireMessMember(),
  validate({ params: monthParams }),
  async (req, res) => {
    sendResponse(res, { data: await reports.getMonthReport(membershipOf(req), param(req, "monthId")) });
  },
);

router.get(
  "/months/:monthId/export/statement/:memberId",
  requireMessMember(),
  validate({ params: statementExportParams }),
  async (req, res) => {
    const membership = membershipOf(req);
    const memberId = req.params.memberId === "me" ? membership.id : param(req, "memberId");
    sendCsv(res, await reports.statementCsv(membership, param(req, "monthId"), memberId));
  },
);

router.get(
  "/months/:monthId/export/:kind",
  requireMessMember(),
  validate({ params: exportParams }),
  async (req, res) => {
    const membership = membershipOf(req);
    const monthId = param(req, "monthId");
    sendCsv(
      res,
      req.params.kind === "summary"
        ? await reports.summaryCsv(membership, monthId)
        : await reports.bazarsCsv(membership, monthId),
    );
  },
);

export default router;
