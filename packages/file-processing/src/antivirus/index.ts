export {
  createClamAvScanner,
  type ParsedClamdResponse,
  parseClamdInstreamResponse,
} from "./clamav-adapter.js";

export type {
  AntivirusHealthResult,
  AntivirusScannerPort,
  ClamAvScannerConfig,
  ClamAvTransportConfig,
  MalwareScanDisposition,
  MalwareScanInput,
  MalwareScanResult,
  MalwareScanStatus,
} from "./scanner.types.js";
