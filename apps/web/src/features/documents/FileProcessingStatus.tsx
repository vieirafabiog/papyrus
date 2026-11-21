import type { FileObjectStatus } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS } from "@docuflow/ui";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyOutlinedIcon from "@mui/icons-material/HourglassEmptyOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";

export type FileProcessingFeedbackLabel = "Em análise" | "Disponível" | "Rejeitado";

export interface FileProcessingDescriptor {
  readonly label: FileProcessingFeedbackLabel;
  readonly chipColor: "warning" | "success" | "error";
  readonly alertSeverity: "info" | "success" | "error";
  readonly canPreview: boolean;
  readonly canDownload: boolean;
  readonly defaultMessage: string;
}

const DEFAULT_SAFE_REJECTION_MESSAGE =
  "O arquivo foi rejeitado na verificação de segurança ou integridade. Envie uma nova versão válida.";

const TECHNICAL_LEAK_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /org\/[0-9a-f-]+/i,
  /\/tmp\//i,
  /[a-f0-9]{64}/i,
  /\b(eicar|win\.|trojan|malware|clamd|clamav|zinstream|polyglot|magic|elf|0x[0-9a-f]+)\b/i,
  /\b(stack|trace|sql|select\s|insert\s|update\s|delete\s|exception|error:|errno|econnrefused|x-amz-)\b/i,
  /[<>]/,
];

const FILE_STATUS_DESCRIPTORS: Readonly<Record<FileObjectStatus, FileProcessingDescriptor>> = {
  UPLOADING: {
    label: "Em análise",
    chipColor: "warning",
    alertSeverity: "info",
    canPreview: false,
    canDownload: false,
    defaultMessage:
      "O envio do arquivo ainda está em andamento. A visualização permanece bloqueada até a conclusão das verificações.",
  },
  QUARANTINED: {
    label: "Em análise",
    chipColor: "warning",
    alertSeverity: "info",
    canPreview: false,
    canDownload: false,
    defaultMessage:
      "Este arquivo está em análise de integridade e segurança. A visualização e o download serão liberados somente após a aprovação.",
  },
  AVAILABLE: {
    label: "Disponível",
    chipColor: "success",
    alertSeverity: "success",
    canPreview: true,
    canDownload: true,
    defaultMessage: "Arquivo verificado e disponível para visualização e download.",
  },
  REJECTED: {
    label: "Rejeitado",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessage: DEFAULT_SAFE_REJECTION_MESSAGE,
  },
  MISSING: {
    label: "Rejeitado",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessage:
      "O arquivo não está disponível para acesso. Envie uma nova versão para restaurar o conteúdo.",
  },
  DELETE_PENDING: {
    label: "Rejeitado",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessage: "Esta versão está indisponível e em remoção programada.",
  },
};

export function canPreviewFileObject(status: FileObjectStatus): boolean {
  return FILE_STATUS_DESCRIPTORS[status].canPreview;
}

export function canDownloadFileObject(status: FileObjectStatus): boolean {
  return FILE_STATUS_DESCRIPTORS[status].canDownload;
}

export function getFileProcessingDescriptor(status: FileObjectStatus): FileProcessingDescriptor {
  return FILE_STATUS_DESCRIPTORS[status];
}

/**
 * Ensures any rejection reason shown in the UI never exposes scanner signatures, object keys,
 * signed URLs, hashes, magic bytes, or technical diagnostics to the end user.
 */
export function sanitizeUserFacingRejectionMessage(rawReason: string | null | undefined): string {
  if (!rawReason) {
    return DEFAULT_SAFE_REJECTION_MESSAGE;
  }

  const trimmed = rawReason.trim();
  if (trimmed.length === 0 || trimmed.length > 180) {
    return DEFAULT_SAFE_REJECTION_MESSAGE;
  }

  for (const pattern of TECHNICAL_LEAK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return DEFAULT_SAFE_REJECTION_MESSAGE;
    }
  }

  return trimmed;
}

function resolveStatusIcon(status: FileObjectStatus): React.ReactElement {
  const descriptor = FILE_STATUS_DESCRIPTORS[status];
  if (descriptor.label === "Disponível") {
    return <CheckCircleOutlineIcon fontSize="small" />;
  }
  if (descriptor.label === "Rejeitado") {
    return <ErrorOutlineIcon fontSize="small" />;
  }
  return <HourglassEmptyOutlinedIcon fontSize="small" />;
}

export interface FileProcessingStatusBadgeProps {
  readonly status: FileObjectStatus;
  readonly size?: "small" | "medium" | undefined;
}

export function FileProcessingStatusBadge({
  status,
  size = "small",
}: FileProcessingStatusBadgeProps) {
  const descriptor = getFileProcessingDescriptor(status);

  return (
    <Chip
      size={size}
      color={descriptor.chipColor}
      icon={resolveStatusIcon(status)}
      label={descriptor.label}
      aria-label={`Estado do arquivo: ${descriptor.label}`}
    />
  );
}

export interface DocumentFileAvailabilityPanelProps {
  readonly fileStatus: FileObjectStatus;
  readonly fileName?: string | undefined;
  readonly rejectionReason?: string | null | undefined;
  readonly onPreview?: (() => void) | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onUploadNewVersion?: (() => void) | undefined;
  readonly children?: ReactNode | undefined;
}

/**
 * Renders safe quarantine/rejection feedback in Portuguese and strictly gates preview content
 * and download actions until `fileStatus === "AVAILABLE"`.
 */
export function DocumentFileAvailabilityPanel({
  fileStatus,
  fileName,
  rejectionReason,
  onPreview,
  onDownload,
  onUploadNewVersion,
  children,
}: DocumentFileAvailabilityPanelProps) {
  const descriptor = getFileProcessingDescriptor(fileStatus);
  const safeAlertMessage =
    fileStatus === "REJECTED"
      ? sanitizeUserFacingRejectionMessage(rejectionReason)
      : descriptor.defaultMessage;

  return (
    <Stack spacing={2}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1.5,
          flexWrap: "wrap",
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <FileProcessingStatusBadge status={fileStatus} />
          {fileName ? (
            <Typography variant="body2" color="text.secondary">
              {fileName}
            </Typography>
          ) : null}
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          {descriptor.canPreview && onPreview ? (
            <Button
              type="button"
              size="small"
              variant="outlined"
              startIcon={<VisibilityOutlinedIcon />}
              onClick={onPreview}
            >
              Visualizar arquivo
            </Button>
          ) : null}

          {descriptor.canDownload && onDownload ? (
            <Button
              type="button"
              size="small"
              variant="contained"
              startIcon={<DownloadOutlinedIcon />}
              onClick={onDownload}
            >
              Baixar arquivo
            </Button>
          ) : null}

          {!descriptor.canPreview && fileStatus === "REJECTED" && onUploadNewVersion ? (
            <Button
              type="button"
              size="small"
              variant="contained"
              startIcon={<UploadFileOutlinedIcon />}
              onClick={onUploadNewVersion}
            >
              Enviar nova versão
            </Button>
          ) : null}
        </Stack>
      </Box>

      {!descriptor.canPreview ? (
        <Alert severity={descriptor.alertSeverity} aria-live="polite">
          {safeAlertMessage}
        </Alert>
      ) : null}

      {descriptor.canPreview ? (
        (children ?? null)
      ) : (
        <Paper
          variant="outlined"
          sx={{
            p: 3,
            textAlign: "center",
            bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
            borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
          }}
        >
          <Stack spacing={1} alignItems="center">
            <LockOutlinedIcon color="action" fontSize="medium" />
            <Typography variant="subtitle1" component="p">
              Pré-visualização bloqueada
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {descriptor.label === "Rejeitado"
                ? "O conteúdo não pode ser exibido porque o arquivo foi rejeitado."
                : "A pré-visualização será habilitada automaticamente quando a análise for concluída."}
            </Typography>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
