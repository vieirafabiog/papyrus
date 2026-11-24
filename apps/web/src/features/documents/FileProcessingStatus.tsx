import type { FileObjectStatus } from "@docuflow/contracts";
import { PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import HourglassEmptyOutlinedIcon from "@mui/icons-material/HourglassEmptyOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import { Alert, Box, Button, Chip, Paper, Stack, Typography } from "@mui/material";
import type { ReactNode } from "react";
import {
  type MessageKey,
  type UiLocale,
  getCurrentUiLocale,
  translate,
  useI18n,
} from "../../i18n/index.js";

export type FileProcessingFeedbackLabel =
  | "Under review"
  | "Available"
  | "Rejected"
  | "Em análise"
  | "Disponível"
  | "Rejeitado";

export interface FileProcessingDescriptor {
  readonly label: FileProcessingFeedbackLabel;
  readonly chipColor: "warning" | "success" | "error";
  readonly alertSeverity: "info" | "success" | "error";
  readonly canPreview: boolean;
  readonly canDownload: boolean;
  readonly defaultMessage: string;
}

const TECHNICAL_LEAK_PATTERNS: readonly RegExp[] = [
  /https?:\/\//i,
  /org\/[0-9a-f-]+/i,
  /\/tmp\//i,
  /[a-f0-9]{64}/i,
  /\b(eicar|win\.|trojan|malware|clamd|clamav|zinstream|polyglot|magic|elf|0x[0-9a-f]+)\b/i,
  /\b(stack|trace|sql|select\s|insert\s|update\s|delete\s|exception|error:|errno|econnrefused|x-amz-)\b/i,
  /[<>]/,
];

interface FileStatusMetadata {
  readonly labelKey: MessageKey;
  readonly chipColor: "warning" | "success" | "error";
  readonly alertSeverity: "info" | "success" | "error";
  readonly canPreview: boolean;
  readonly canDownload: boolean;
  readonly defaultMessageKey: MessageKey;
}

const FILE_STATUS_METADATA: Readonly<Record<FileObjectStatus, FileStatusMetadata>> = {
  UPLOADING: {
    labelKey: "documents.fileStatus.underReview",
    chipColor: "warning",
    alertSeverity: "info",
    canPreview: false,
    canDownload: false,
    defaultMessageKey: "documents.fileStatus.uploadingMessage",
  },
  QUARANTINED: {
    labelKey: "documents.fileStatus.underReview",
    chipColor: "warning",
    alertSeverity: "info",
    canPreview: false,
    canDownload: false,
    defaultMessageKey: "documents.fileStatus.quarantinedMessage",
  },
  AVAILABLE: {
    labelKey: "documents.fileStatus.available",
    chipColor: "success",
    alertSeverity: "success",
    canPreview: true,
    canDownload: true,
    defaultMessageKey: "documents.fileStatus.availableMessage",
  },
  REJECTED: {
    labelKey: "documents.fileStatus.rejected",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessageKey: "documents.fileStatus.rejectedMessage",
  },
  MISSING: {
    labelKey: "documents.fileStatus.rejected",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessageKey: "documents.fileStatus.missingMessage",
  },
  DELETE_PENDING: {
    labelKey: "documents.fileStatus.rejected",
    chipColor: "error",
    alertSeverity: "error",
    canPreview: false,
    canDownload: false,
    defaultMessageKey: "documents.fileStatus.deletePendingMessage",
  },
};

export function canPreviewFileObject(status: FileObjectStatus): boolean {
  return FILE_STATUS_METADATA[status].canPreview;
}

export function canDownloadFileObject(status: FileObjectStatus): boolean {
  return FILE_STATUS_METADATA[status].canDownload;
}

export function getFileProcessingDescriptor(
  status: FileObjectStatus,
  locale: UiLocale = getCurrentUiLocale(),
): FileProcessingDescriptor {
  const meta = FILE_STATUS_METADATA[status];
  return {
    label: translate(meta.labelKey, undefined, locale) as FileProcessingFeedbackLabel,
    chipColor: meta.chipColor,
    alertSeverity: meta.alertSeverity,
    canPreview: meta.canPreview,
    canDownload: meta.canDownload,
    defaultMessage: translate(meta.defaultMessageKey, undefined, locale),
  };
}

/**
 * Ensures any rejection reason shown in the UI never exposes scanner signatures, object keys,
 * signed URLs, hashes, magic bytes, or technical diagnostics to the end user.
 */
export function sanitizeUserFacingRejectionMessage(
  rawReason: string | null | undefined,
  locale: UiLocale = getCurrentUiLocale(),
): string {
  const defaultSafeMessage = translate("documents.fileStatus.rejectedMessage", undefined, locale);
  if (!rawReason) {
    return defaultSafeMessage;
  }

  const trimmed = rawReason.trim();
  if (trimmed.length === 0 || trimmed.length > 180) {
    return defaultSafeMessage;
  }

  for (const pattern of TECHNICAL_LEAK_PATTERNS) {
    if (pattern.test(trimmed)) {
      return defaultSafeMessage;
    }
  }

  return trimmed;
}

function resolveStatusIcon(status: FileObjectStatus): React.ReactElement {
  if (status === "AVAILABLE") {
    return <CheckCircleOutlineIcon fontSize="small" />;
  }
  if (status === "REJECTED" || status === "MISSING" || status === "DELETE_PENDING") {
    return <ErrorOutlineIcon fontSize="small" />;
  }
  return <HourglassEmptyOutlinedIcon fontSize="small" />;
}

export interface FileProcessingStatusBadgeProps {
  readonly status: FileObjectStatus;
  readonly size?: "small" | "medium" | undefined;
  readonly locale?: UiLocale | undefined;
}

export function FileProcessingStatusBadge({
  status,
  size = "small",
  locale,
}: FileProcessingStatusBadgeProps) {
  const i18n = useI18n();
  const effectiveLocale = locale ?? i18n.locale;
  const descriptor = getFileProcessingDescriptor(status, effectiveLocale);

  return (
    <Chip
      size={size}
      color={descriptor.chipColor}
      icon={resolveStatusIcon(status)}
      label={descriptor.label}
      aria-label={translate(
        "documents.fileStatus.ariaLabel",
        { status: descriptor.label },
        effectiveLocale,
      )}
    />
  );
}

export interface DocumentFileAvailabilityPanelProps {
  readonly fileStatus: FileObjectStatus;
  readonly fileName?: string | undefined;
  readonly rejectionReason?: string | null | undefined;
  readonly locale?: UiLocale | undefined;
  readonly onPreview?: (() => void) | undefined;
  readonly onDownload?: (() => void) | undefined;
  readonly onUploadNewVersion?: (() => void) | undefined;
  readonly children?: ReactNode | undefined;
}

/**
 * Renders safe quarantine/rejection feedback and strictly gates preview content
 * and download actions until `fileStatus === "AVAILABLE"`.
 */
export function DocumentFileAvailabilityPanel({
  fileStatus,
  fileName,
  rejectionReason,
  locale,
  onPreview,
  onDownload,
  onUploadNewVersion,
  children,
}: DocumentFileAvailabilityPanelProps) {
  const i18n = useI18n();
  const effectiveLocale = locale ?? i18n.locale;
  const descriptor = getFileProcessingDescriptor(fileStatus, effectiveLocale);
  const safeAlertMessage =
    fileStatus === "REJECTED"
      ? sanitizeUserFacingRejectionMessage(rejectionReason, effectiveLocale)
      : descriptor.defaultMessage;
  const isRejectedState =
    fileStatus === "REJECTED" || fileStatus === "MISSING" || fileStatus === "DELETE_PENDING";

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
          <FileProcessingStatusBadge status={fileStatus} locale={effectiveLocale} />
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
              {translate("documents.fileStatus.previewFile", undefined, effectiveLocale)}
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
              {translate("documents.fileStatus.downloadFile", undefined, effectiveLocale)}
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
              {translate("documents.fileStatus.uploadNewVersion", undefined, effectiveLocale)}
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
            bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
            borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
          }}
        >
          <Stack spacing={1} alignItems="center">
            <LockOutlinedIcon color="action" fontSize="medium" />
            <Typography variant="subtitle1" component="p">
              {translate(
                "documents.fileStatus.previewUnavailableTitle",
                undefined,
                effectiveLocale,
              )}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {isRejectedState
                ? translate(
                    "documents.fileStatus.previewBlockedRejected",
                    undefined,
                    effectiveLocale,
                  )
                : translate(
                    "documents.fileStatus.previewBlockedPending",
                    undefined,
                    effectiveLocale,
                  )}
            </Typography>
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
