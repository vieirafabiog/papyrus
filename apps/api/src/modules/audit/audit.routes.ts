import { evaluateAuthorization } from "@docuflow/auth";
import {
  type AuthMeResponse,
  CONTRACTS_API_PREFIX,
  auditEventsExportQuerySchema,
  auditEventsQuerySchema,
} from "@docuflow/contracts";
import type { AuthorizationRepository } from "@docuflow/database";
import {
  type AuditEventRecord,
  type AuditRepositoryPort,
  type AuditWriter,
  createAuditWriter,
} from "@docuflow/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildRolePermissionsLookup, toSubjectContext } from "../../plugins/authorization.js";
import { SESSION_COOKIE_NAME } from "../auth/auth.routes.js";
import type { AuthService } from "../auth/auth.service.js";

const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/;

export interface AuditRoutesDependencies {
  readonly authService: AuthService;
  readonly authzRepository: AuthorizationRepository;
  readonly auditRepository: AuditRepositoryPort;
  readonly now?: (() => Date) | undefined;
}

function setPrivateAuditHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store, no-cache, must-revalidate, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header("Vary", "Cookie, Origin");
  reply.header("X-Content-Type-Options", "nosniff");
}

function parsePeriodBoundary(raw: string, boundary: "start" | "end"): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    return new Date(`${raw}${suffix}`);
  }
  return new Date(raw);
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

function formatAuditEventsCsv(items: readonly AuditEventRecord[]): string {
  const header = [
    "id",
    "occurred_at",
    "actor_user_id",
    "actor_name",
    "actor_email",
    "action",
    "resource_type",
    "resource_id",
    "result",
    "request_id",
    "ip_address",
    "metadata",
  ].join(",");

  const lines = items.map((item) =>
    [
      escapeCsvCell(item.id),
      escapeCsvCell(item.occurredAt),
      escapeCsvCell(item.actorUserId),
      escapeCsvCell(item.actorName ?? null),
      escapeCsvCell(item.actorEmail ?? null),
      escapeCsvCell(item.action),
      escapeCsvCell(item.resourceType),
      escapeCsvCell(item.resourceId),
      escapeCsvCell(item.result),
      escapeCsvCell(item.requestId),
      escapeCsvCell(item.ipAddress ?? null),
      escapeCsvCell(JSON.stringify(item.metadata ?? {})),
    ].join(","),
  );

  return `\uFEFF${[header, ...lines].join("\r\n")}\r\n`;
}

async function requireAuthorizedAuditViewer(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuditRoutesDependencies,
  auditWriter: AuditWriter,
  mode: "VIEW" | "EXPORT",
): Promise<AuthMeResponse | null> {
  const rawToken = request.cookies[SESSION_COOKIE_NAME];
  const outcome = await deps.authService.getMe(rawToken);
  if (!outcome) {
    void reply.status(401).send({
      error: {
        code: "UNAUTHORIZED",
        message: "Sessão não autenticada ou expirada.",
        requestId: request.id,
      },
    });
    return null;
  }

  const loaded = await deps.authzRepository.loadSubject(
    outcome.me.user.organizationId,
    outcome.me.user.id,
  );
  const subject = toSubjectContext(loaded);
  const rolePermissions = buildRolePermissionsLookup(loaded);

  const decision = evaluateAuthorization(
    subject,
    { action: "VIEW_AUDIT", resource: "AUDIT", scope: { type: "GLOBAL" } },
    rolePermissions,
  );

  if (!decision.allowed) {
    await auditWriter.write({
      organizationId: outcome.me.user.organizationId,
      actorUserId: outcome.me.user.id,
      action: mode === "EXPORT" ? "AUDIT_EXPORT_DENIED" : "AUTHORIZATION_DENIED",
      resourceType: "AUDIT",
      resourceId: null,
      result: "DENIED",
      requestId: request.id,
      ipAddress: request.ip,
      metadata: {
        requiredAction: "VIEW_AUDIT",
        operation: mode,
        reason: decision.reason,
      },
    });

    void reply.status(403).send({
      error: {
        code: "FORBIDDEN",
        message:
          mode === "EXPORT"
            ? "Você não possui permissão para exportar a trilha de auditoria."
            : "Você não possui permissão para consultar a trilha de auditoria.",
        requestId: request.id,
      },
    });
    return null;
  }

  return outcome.me;
}

/**
 * Registers authorized audit query (`GET /api/v1/admin/audit-events`), filter facet
 * discovery (`GET /api/v1/admin/audit-events/facets`), and bounded export
 * (`GET /api/v1/admin/audit-events/export`) endpoints backed by PostgreSQL.
 */
export async function registerAuditRoutes(
  app: FastifyInstance,
  deps: AuditRoutesDependencies,
): Promise<void> {
  const { auditRepository, now } = deps;
  const auditWriter = createAuditWriter({ repository: auditRepository });

  app.get(`${CONTRACTS_API_PREFIX}/admin/audit-events`, async (request, reply) => {
    const me = await requireAuthorizedAuditViewer(request, reply, deps, auditWriter, "VIEW");
    if (!me) {
      return reply;
    }

    const queryParsed = auditEventsQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ??
            "Parâmetros inválidos para consulta de auditoria.",
          requestId: request.id,
        },
      });
    }

    const q = queryParsed.data;
    const occurredFrom = q.from ? parsePeriodBoundary(q.from, "start") : undefined;
    const occurredTo = q.to ? parsePeriodBoundary(q.to, "end") : undefined;

    if (
      occurredFrom !== undefined &&
      occurredTo !== undefined &&
      occurredFrom.getTime() > occurredTo.getTime()
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "A data inicial do período não pode ser posterior à data final.",
          requestId: request.id,
        },
      });
    }

    const result = await auditRepository.list({
      organizationId: me.user.organizationId,
      actorUserId: q.actorUserId,
      action: q.action,
      resourceType: q.resourceType,
      resourceId: q.resourceId,
      result: q.result,
      occurredFrom,
      occurredTo,
      sortBy: q.sortBy,
      sortDirection: q.sortDirection,
      page: q.page,
      pageSize: q.pageSize,
    });

    setPrivateAuditHeaders(reply);

    return reply.status(200).send({
      data: {
        items: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          totalItems: result.totalItems,
          totalPages: result.totalPages,
        },
      },
    });
  });

  app.get(`${CONTRACTS_API_PREFIX}/admin/audit-events/facets`, async (request, reply) => {
    const me = await requireAuthorizedAuditViewer(request, reply, deps, auditWriter, "VIEW");
    if (!me) {
      return reply;
    }

    const facets = auditRepository.listFacets
      ? await auditRepository.listFacets(me.user.organizationId)
      : { actors: [], actions: [], resourceTypes: [] };

    setPrivateAuditHeaders(reply);

    return reply.status(200).send({
      data: facets,
    });
  });

  app.get(`${CONTRACTS_API_PREFIX}/admin/audit-events/export`, async (request, reply) => {
    const me = await requireAuthorizedAuditViewer(request, reply, deps, auditWriter, "EXPORT");
    if (!me) {
      return reply;
    }

    const queryParsed = auditEventsExportQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message:
            queryParsed.error.issues[0]?.message ??
            "Parâmetros inválidos para exportação de auditoria.",
          requestId: request.id,
        },
      });
    }

    const q = queryParsed.data;
    const occurredFrom = q.from ? parsePeriodBoundary(q.from, "start") : undefined;
    const occurredTo = q.to ? parsePeriodBoundary(q.to, "end") : undefined;

    if (
      occurredFrom !== undefined &&
      occurredTo !== undefined &&
      occurredFrom.getTime() > occurredTo.getTime()
    ) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "A data inicial do período não pode ser posterior à data final.",
          requestId: request.id,
        },
      });
    }

    const items = auditRepository.listForExport
      ? await auditRepository.listForExport({
          organizationId: me.user.organizationId,
          actorUserId: q.actorUserId,
          action: q.action,
          resourceType: q.resourceType,
          resourceId: q.resourceId,
          result: q.result,
          occurredFrom,
          occurredTo,
          sortBy: q.sortBy,
          sortDirection: q.sortDirection,
          limit: q.limit,
        })
      : (
          await auditRepository.list({
            organizationId: me.user.organizationId,
            actorUserId: q.actorUserId,
            action: q.action,
            resourceType: q.resourceType,
            resourceId: q.resourceId,
            result: q.result,
            occurredFrom,
            occurredTo,
            sortBy: q.sortBy,
            sortDirection: q.sortDirection,
            page: 1,
            pageSize: q.limit,
          })
        ).items;

    await auditWriter.write({
      organizationId: me.user.organizationId,
      actorUserId: me.user.id,
      action: "AUDIT_EXPORTED",
      resourceType: "AUDIT",
      resourceId: null,
      result: "SUCCESS",
      requestId: request.id,
      ipAddress: request.ip,
      metadata: {
        format: q.format,
        exportedCount: items.length,
        hasActorFilter: q.actorUserId !== undefined,
        hasActionFilter: q.action !== undefined,
        hasResourceFilter: q.resourceType !== undefined || q.resourceId !== undefined,
        hasPeriodFilter: occurredFrom !== undefined || occurredTo !== undefined,
      },
    });

    const exportedAt = (now ? now() : new Date()).toISOString();
    const dateStamp = exportedAt.slice(0, 10);
    setPrivateAuditHeaders(reply);

    if (q.format === "json") {
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header(
        "Content-Disposition",
        `attachment; filename="auditoria-docuflow-${dateStamp}.json"`,
      );
      return reply.status(200).send(
        JSON.stringify(
          {
            exportedAt,
            totalExported: items.length,
            items,
          },
          null,
          2,
        ),
      );
    }

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="auditoria-docuflow-${dateStamp}.csv"`,
    );
    return reply.status(200).send(formatAuditEventsCsv(items));
  });
}
