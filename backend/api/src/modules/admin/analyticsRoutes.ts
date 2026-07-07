import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  AdminListOrdersResponseSchema,
  AdminOrderListQuerySchema,
  DashboardQuerySchema,
  DashboardResponseSchema,
  GstReportResponseSchema,
  H1RegisterResponseSchema,
  ReportQuerySchema,
  Role,
  SalesReportResponseSchema,
} from "@medrush/contracts";
import { getDashboard } from "./dashboardService";
import { adminOrdersCsv, listAdminOrders } from "./orderService";
import {
  gstReport,
  gstReportCsv,
  h1Register,
  h1RegisterCsv,
  salesReport,
  salesReportCsv,
} from "./reportService";

/**
 * Admin analytics (BLUEPRINT §7.2, §19 — role ADMIN only): dashboard KPIs, order
 * search + CSV export, and the sales / GST / H1 registers. Registered under the
 * /v1 prefix by modules/v1.ts. Every route is read-only.
 *
 * CSV branches carry `text/csv` with a download disposition and return the raw
 * string; those routes therefore declare no zod `response` schema (a string is
 * sent verbatim by Fastify), and the JSON branch is instead validated in-handler
 * against the frozen contract response schema so shapes never drift.
 */

const ADMIN_ROLES: Role[] = [Role.ADMIN];

/** Attach the CSV download headers (§7 ops brief) for an export response. */
function asCsvAttachment(reply: FastifyReply, filename: string): void {
  reply.header("content-type", "text/csv; charset=utf-8");
  reply.header("content-disposition", `attachment; filename="${filename}"`);
}

export const adminAnalyticsRoutes: FastifyPluginAsync = async (app) => {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // §12: dashboards, order search and statutory reports are live/sensitive data.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    return payload;
  });

  /* ------------------------------------------------------------- dashboard */

  typed.get(
    "/admin/dashboard",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Store KPIs over the IST range (today | 7d | 30d)",
        querystring: DashboardQuerySchema,
        response: { 200: DashboardResponseSchema },
      },
    },
    async (request) => ({ data: await getDashboard(request.query.range) }),
  );

  /* ---------------------------------------------------------------- orders */

  typed.get(
    "/admin/orders",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Order search (cursor-paginated; filters + free-text; format=csv export)",
        querystring: AdminOrderListQuerySchema,
      },
    },
    async (request, reply) => {
      if (request.query.format === "csv") {
        asCsvAttachment(reply, "orders.csv");
        return adminOrdersCsv(request.query);
      }
      const { orders, nextCursor } = await listAdminOrders(request.query);
      return AdminListOrdersResponseSchema.parse({ data: orders, meta: { nextCursor } });
    },
  );

  /* --------------------------------------------------------------- reports */

  typed.get(
    "/admin/reports/sales",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Sales register — per-IST-day rollup of DELIVERED orders + totals (format=csv)",
        querystring: ReportQuerySchema,
      },
    },
    async (request, reply) => {
      if (request.query.format === "csv") {
        asCsvAttachment(reply, `sales_${request.query.from}_${request.query.to}.csv`);
        return salesReportCsv(request.query);
      }
      return SalesReportResponseSchema.parse({ data: await salesReport(request.query) });
    },
  );

  typed.get(
    "/admin/reports/gst",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "GST register — HSN×rate back-compute over DELIVERED items + totals (format=csv)",
        querystring: ReportQuerySchema,
      },
    },
    async (request, reply) => {
      if (request.query.format === "csv") {
        asCsvAttachment(reply, `gst_${request.query.from}_${request.query.to}.csv`);
        return gstReportCsv(request.query);
      }
      return GstReportResponseSchema.parse({ data: await gstReport(request.query) });
    },
  );

  typed.get(
    "/admin/reports/h1-register",
    {
      config: { roles: ADMIN_ROLES },
      schema: {
        tags: ["admin"],
        summary: "Schedule H1 register — Rx lines × dispensed batch + patient/doctor (format=csv)",
        querystring: ReportQuerySchema,
      },
    },
    async (request, reply) => {
      if (request.query.format === "csv") {
        asCsvAttachment(reply, `h1-register_${request.query.from}_${request.query.to}.csv`);
        return h1RegisterCsv(request.query);
      }
      return H1RegisterResponseSchema.parse({ data: await h1Register(request.query) });
    },
  );
};
