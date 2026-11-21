import type { Readable } from "node:stream";

export type MalwareScanStatus = "CLEAN" | "INFECTED" | "UNAVAILABLE" | "TIMEOUT" | "ERROR";

export type MalwareScanDisposition = "APPROVE" | "REJECT" | "DEFER_RETRY";

export interface MalwareScanInput {
  readonly stream: Readable;
  readonly declaredSizeBytes?: number | undefined;
  readonly abortSignal?: AbortSignal | undefined;
}

export interface MalwareScanResult {
  readonly status: MalwareScanStatus;
  readonly approved: boolean;
  readonly disposition: MalwareScanDisposition;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly diagnosticCode: string;
  readonly detectedSignature: string | null;
  readonly bytesScanned: number;
  readonly durationMs: number;
}

export interface AntivirusHealthResult {
  readonly healthy: boolean;
  readonly status: "AVAILABLE" | "UNAVAILABLE" | "TIMEOUT";
  readonly message: string;
  readonly checkedAt: Date;
}

export interface AntivirusScannerPort {
  readonly providerName: string;
  checkHealth(abortSignal?: AbortSignal): Promise<AntivirusHealthResult>;
  scanStream(input: MalwareScanInput): Promise<MalwareScanResult>;
}

export type ClamAvTransportConfig =
  | {
      readonly transport: "tcp";
      readonly host: string;
      readonly port: number;
    }
  | {
      readonly transport: "unix";
      readonly socketPath: string;
    };

export type ClamAvScannerConfig = ClamAvTransportConfig & {
  readonly timeoutMs?: number | undefined;
  readonly chunkSizeBytes?: number | undefined;
  readonly maxStreamBytes?: number | undefined;
};
