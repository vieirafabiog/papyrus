export type PublicDependencyState = "ok" | "degraded" | "unavailable";

export interface HealthProbeOutcome {
  readonly healthy: boolean;
  readonly message?: string | undefined;
}

export interface CriticalHealthDependency {
  readonly name: string;
  readonly critical?: boolean | undefined;
  readonly check: () => Promise<HealthProbeOutcome>;
}

export interface PublicReadinessReport {
  readonly status: "ready" | "not_ready";
  readonly checkedAt: string;
  readonly checks: Readonly<Record<string, PublicDependencyState>>;
}

export interface OperationalComponentStatus {
  readonly name: string;
  readonly status: PublicDependencyState;
  readonly message: string;
  readonly checkedAt: string;
}

export interface OperationalStorageStatusSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly isDefault: boolean;
  readonly status: string;
  readonly lastHealthCheckAt: string | null;
  readonly lastHealthMessage: string | null;
}

export interface AdminSystemStatusReport {
  readonly overallStatus: "healthy" | "degraded";
  readonly checkedAt: string;
  readonly components: {
    readonly database: OperationalComponentStatus;
    readonly worker: OperationalComponentStatus;
  };
  readonly storageConnections: readonly OperationalStorageStatusSummary[];
}

export interface ApiHealthDependencies {
  readonly checkDatabase?: (() => Promise<HealthProbeOutcome>) | undefined;
  readonly checkWorker?: (() => Promise<HealthProbeOutcome>) | undefined;
  readonly criticalDependencies?: readonly CriticalHealthDependency[] | undefined;
  readonly listStorageConnections?:
    | ((organizationId: string) => Promise<readonly OperationalStorageStatusSummary[]>)
    | undefined;
  readonly probeTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

export function sanitizeOperationalMessage(
  rawMessage: string | undefined,
  healthy: boolean,
): string {
  if (!rawMessage || rawMessage.trim().length === 0) {
    return healthy ? "Serviço operacional." : "Dependência indisponível.";
  }
  return rawMessage
    .replace(/postgres(?:ql)?:\/\/[^\s'"]+/gi, "postgresql://[REDACTED]")
    .replace(/https?:\/\/[^\s'"]+/gi, "[ENDPOINT]")
    .replace(/(password|pwd|secret|token|key)\s*[:=]\s*[^\s;,'"]+/gi, "$1=[REDACTED]")
    .trim()
    .slice(0, 200);
}

async function runProbeWithTimeout(
  probe: () => Promise<HealthProbeOutcome>,
  timeoutMs: number,
): Promise<{ readonly healthy: boolean; readonly message?: string | undefined }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      probe(),
      new Promise<HealthProbeOutcome>((resolve) => {
        timer = setTimeout(() => {
          resolve({ healthy: false, message: "Tempo limite excedido na verificação." });
        }, timeoutMs);
      }),
    ]);
    return result;
  } catch {
    return { healthy: false, message: "Falha ao consultar dependência." };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export interface ApiHealthService {
  checkPublicReadiness(): Promise<PublicReadinessReport>;
  getAdminSystemStatus(organizationId: string): Promise<AdminSystemStatusReport>;
}

/**
 * Separates minimal liveness from dependency-verified readiness while ensuring
 * public probes never leak internal hostnames, connection strings, paths, or errors.
 */
export function createApiHealthService(deps: ApiHealthDependencies = {}): ApiHealthService {
  const timeoutMs = Math.max(250, deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const nowFn = deps.now ?? (() => new Date());

  return {
    async checkPublicReadiness(): Promise<PublicReadinessReport> {
      const checkedAt = nowFn().toISOString();
      const checks: Record<string, PublicDependencyState> = {};

      if (!deps.checkDatabase) {
        checks.database = "unavailable";
        return {
          status: "not_ready",
          checkedAt,
          checks,
        };
      }

      const probes: Array<{
        readonly name: string;
        readonly critical: boolean;
        readonly check: () => Promise<HealthProbeOutcome>;
      }> = [
        { name: "database", critical: true, check: deps.checkDatabase },
        ...(deps.checkWorker ? [{ name: "worker", critical: false, check: deps.checkWorker }] : []),
        ...(deps.criticalDependencies ?? []).map((item) => ({
          name: item.name,
          critical: item.critical ?? true,
          check: item.check,
        })),
      ];

      const settled = await Promise.all(
        probes.map(async (item) => ({
          name: item.name,
          critical: item.critical,
          result: await runProbeWithTimeout(item.check, timeoutMs),
        })),
      );

      let allCriticalHealthy = true;
      for (const entry of settled) {
        if (entry.result.healthy) {
          checks[entry.name] = "ok";
        } else {
          checks[entry.name] = "degraded";
          if (entry.critical) {
            allCriticalHealthy = false;
          }
        }
      }

      return {
        status: allCriticalHealthy ? "ready" : "not_ready",
        checkedAt,
        checks,
      };
    },

    async getAdminSystemStatus(organizationId: string): Promise<AdminSystemStatusReport> {
      const checkedAt = nowFn().toISOString();

      const dbOutcome = deps.checkDatabase
        ? await runProbeWithTimeout(deps.checkDatabase, timeoutMs)
        : { healthy: false, message: "Verificação de banco não configurada." };

      const workerOutcome = deps.checkWorker
        ? await runProbeWithTimeout(deps.checkWorker, timeoutMs)
        : { healthy: false, message: "Heartbeat do worker não configurado neste processo." };

      const storageConnections = deps.listStorageConnections
        ? await deps.listStorageConnections(organizationId).catch(() => [])
        : [];

      const dbStatus: PublicDependencyState = !deps.checkDatabase
        ? "unavailable"
        : dbOutcome.healthy
          ? "ok"
          : "degraded";
      const workerStatus: PublicDependencyState = !deps.checkWorker
        ? "unavailable"
        : workerOutcome.healthy
          ? "ok"
          : "degraded";

      const hasStorageFailure = storageConnections.some((conn) => conn.status === "ERROR");

      return {
        overallStatus:
          dbStatus === "ok" && workerStatus !== "degraded" && !hasStorageFailure
            ? "healthy"
            : "degraded",
        checkedAt,
        components: {
          database: {
            name: "Banco de dados PostgreSQL",
            status: dbStatus,
            message: sanitizeOperationalMessage(dbOutcome.message, dbOutcome.healthy),
            checkedAt,
          },
          worker: {
            name: "Worker de processamento",
            status: workerStatus,
            message: sanitizeOperationalMessage(workerOutcome.message, workerOutcome.healthy),
            checkedAt,
          },
        },
        storageConnections,
      };
    },
  };
}
