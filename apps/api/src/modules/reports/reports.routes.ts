import { CONTRACTS_API_PREFIX, repositoryReportQuerySchema } from "@papyrus/contracts";
import type { ReportRepository, RepositoryReportRecord } from "@papyrus/database";
import { type AuditRepositoryPort, createAuditWriter } from "@papyrus/domain";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  type DocumentAuthorizationGuard,
  buildDocumentQueryScope,
} from "../../plugins/authorization.js";

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

export interface ReportRoutesDependencies {
  readonly guard: DocumentAuthorizationGuard;
  readonly reportRepository: ReportRepository;
  readonly auditRepository?: AuditRepositoryPort | undefined;
  readonly now?: (() => Date) | undefined;
}

function setPrivateReportHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie, Origin");
  reply.header("X-Content-Type-Options", "nosniff");
}

function escapeCsvCell(rawValue: string | number | boolean | null | undefined): string {
  if (rawValue === null || rawValue === undefined) {
    return "";
  }
  let text = String(rawValue);
  if (CSV_FORMULA_PREFIX.test(text)) {
    text = `'${text}`;
  }
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatRepositoryReportCsv(report: RepositoryReportRecord): string {
  const rows: string[] = [];
  rows.push(
    [
      "secao",
      "item",
      "documentos",
      "versoes",
      "vencidos",
      "proximos_vencimento",
      "arquivos",
      "espaco_bytes",
    ].join(","),
  );

  rows.push(
    [
      "RESUMO",
      "Total autorizado",
      report.totals.totalDocuments,
      report.totals.totalVersions,
      report.expirations.expired,
      report.expirations.expiringSoon,
      report.totals.totalActiveFiles,
      report.totals.storageUsedBytes,
    ]
      .map(escapeCsvCell)
      .join(","),
  );

  for (const item of report.byStatus) {
    rows.push(
      ["STATUS", item.status, item.documentCount, "", "", "", "", item.storageBytes]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  for (const item of report.byCategory) {
    rows.push(
      [
        "CATEGORIA",
        item.categoryName,
        item.documentCount,
        item.versionCount,
        item.expiredCount,
        item.expiringSoonCount,
        "",
        item.storageBytes,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  for (const item of report.byStorageConnection) {
    rows.push(
      [
        "ARMAZENAMENTO",
        `${item.storageConnectionName} (${item.kind})`,
        "",
        "",
        "",
        "",
        item.fileCount,
        item.storageBytes,
      ]
        .map(escapeCsvCell)
        .join(","),
    );
  }

  return `\uFEFF${rows.join("\r\n")}\r\n`;
}

/**
 * Registers repository report aggregations (`GET /api/v1/reports/overview`) and
 * authorized CSV export (`GET /api/v1/reports/export.csv`) strictly scoped by
 * server-side document permissions before any counting or grouping occurs.
 */
export async function registerReportRoutes(
  app: FastifyInstance,
  deps: ReportRoutesDependencies,
): Promise<void> {
  const { guard, reportRepository, auditRepository, now } = deps;
  const auditWriter = auditRepository ? createAuditWriter({ repository: auditRepository }) : null;

  const loadAuthorizedReport = async (
    requestQuery: unknown,
    ctx: NonNullable<Awaited<ReturnType<DocumentAuthorizationGuard["requireSubject"]>>>,
  ): Promise<
    | { readonly ok: true; readonly report: RepositoryReportRecord }
    | { readonly ok: false; readonly message: string }
  > => {
    const parsed = repositoryReportQuerySchema.safeParse(requestQuery ?? {});
    if (!parsed.success) {
      return {
        ok: false,
        message:
          parsed.error.issues[0]?.message ?? "Parâmetros inválidos para geração do relatório.",
      };
    }

    const activeAllowRoleIds = Array.from(
      new Set(
        ctx.loaded.assignments
          .filter((assignment) => assignment.effect === "ALLOW")
          .map((assignment) => assignment.roleId),
      ),
    );

    const report = await reportRepository.getAuthorizedRepositoryReport({
      organizationId: ctx.me.user.organizationId,
      userId: ctx.me.user.id,
      groupIds: ctx.loaded.groupIds,
      roleIds: activeAllowRoleIds,
      scope: buildDocumentQueryScope(ctx.loaded, ctx.rolePermissions, "READ"),
      expirationWindowDays: parsed.data.expirationWindowDays,
      categoryId: parsed.data.categoryId,
      status: parsed.data.status,
      referenceDate: now ? now() : new Date(),
    });

    return { ok: true, report };
  };

  app.get(`${CONTRACTS_API_PREFIX}/reports/overview`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const outcome = await loadAuthorizedReport(request.query, ctx);
    if (!outcome.ok) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: outcome.message,
          requestId: request.id,
        },
      });
    }

    setPrivateReportHeaders(reply);
    return reply.status(200).send({ data: outcome.report });
  });

  app.get(`${CONTRACTS_API_PREFIX}/reports/export.csv`, async (request, reply) => {
    const ctx = await guard.requireSubject(request, reply);
    if (!ctx) {
      return reply;
    }

    const outcome = await loadAuthorizedReport(request.query, ctx);
    if (!outcome.ok) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: outcome.message,
          requestId: request.id,
        },
      });
    }

    if (auditWriter) {
      await auditWriter.write({
        organizationId: ctx.me.user.organizationId,
        actorUserId: ctx.me.user.id,
        action: "REPORT_EXPORTED",
        resourceType: "REPORT",
        resourceId: null,
        result: "SUCCESS",
        requestId: request.id,
        ipAddress: request.ip,
        metadata: {
          format: "csv",
          totalDocuments: outcome.report.totals.totalDocuments,
          windowDays: outcome.report.expirations.windowDays,
        },
      });
    }

    setPrivateReportHeaders(reply);
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", 'attachment; filename="papyrus-relatorio-acervo.csv"');
    return reply.status(200).send(formatRepositoryReportCsv(outcome.report));
  });
}
