import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import CategoryOutlinedIcon from "@mui/icons-material/CategoryOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import EventOutlinedIcon from "@mui/icons-material/EventOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import SendOutlinedIcon from "@mui/icons-material/SendOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import { Alert, Box, Button, Chip, Divider, Grid, Paper, Stack, Typography } from "@mui/material";
import type {
  DocumentMetadataValue,
  DocumentStatus,
  DocumentVersionHistoryItem,
} from "@papyrus/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { DocumentTagsField } from "../tags/DocumentTagsField.js";
import { DocumentCommentsPanel } from "./DocumentCommentsPanel.js";
import { DocumentLifecycleActions } from "./DocumentLifecycleActions.js";
import { DocumentMetadataForm } from "./DocumentMetadataForm.js";
import { DocumentPreviewPanel } from "./DocumentPreviewPanel.js";
import { DocumentWorkflowTimeline } from "./DocumentWorkflowTimeline.js";
import { DocumentFileAvailabilityPanel } from "./FileProcessingStatus.js";
import { StartWorkflowDialog } from "./StartWorkflowDialog.js";
import { UploadDialog } from "./UploadDialog.js";
import { VersionHistory } from "./VersionHistory.js";
import {
  documentDetailsQueryKey,
  documentVersionsQueryKey,
  useDocumentDetailsQuery,
} from "./useDocumentDetails.js";

const DOCUMENT_STATUS_COLOR: Readonly<
  Record<DocumentStatus, "default" | "info" | "success" | "warning" | "error">
> = {
  DRAFT: "default",
  IN_REVIEW: "info",
  APPROVED: "success",
  REJECTED: "error",
  ARCHIVED: "default",
  EXPIRED: "warning",
  DELETED: "error",
};

function formatIsoCalendarDate(
  isoDate: string | null,
  formatDateFn: (value: string | Date | null | undefined, emptyFallback?: string) => string,
  emptyFallback: string,
): string {
  if (!isoDate) {
    return emptyFallback;
  }
  const [yearRaw, monthRaw, dayRaw] = isoDate.split("-");
  if (!yearRaw || !monthRaw || !dayRaw) {
    return isoDate;
  }
  const localDate = new Date(Number(yearRaw), Number(monthRaw) - 1, Number(dayRaw));
  if (Number.isNaN(localDate.getTime())) {
    return isoDate;
  }
  return formatDateFn(localDate, emptyFallback);
}

function formatMetadataValue(
  value: DocumentMetadataValue | undefined,
  t: (key: MessageKey) => string,
  formatDateFn: (value: string | Date | null | undefined, emptyFallback?: string) => string,
  formatNumberFn: (value: number) => string,
): string {
  const notProvided = t("documents.common.notProvided");
  if (value === undefined || value === null) {
    return notProvided;
  }
  if (typeof value === "boolean") {
    return value ? t("documents.common.yes") : t("documents.common.no");
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : t("documents.common.noItemsSelected");
  }
  if (typeof value === "number") {
    return formatNumberFn(value);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatIsoCalendarDate(value, formatDateFn, notProvided);
  }
  return value.trim().length > 0 ? value : notProvided;
}

/**
 * Document details view displaying taxonomy, owner, dates, custom fields,
 * file security status, and authorized actions.
 */
export function DocumentDetailsPage() {
  const { t, formatDate, formatDateTime, formatNumber, formatBytes } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploadNewVersionOpen, setUploadNewVersionOpen] = useState(false);
  const [startWorkflowOpen, setStartWorkflowOpen] = useState(false);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [previewVersion, setPreviewVersion] = useState<DocumentVersionHistoryItem | null>(null);
  const previewSectionRef = useRef<HTMLDivElement | null>(null);
  const [lifecycleFeedback, setLifecycleFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const query = useDocumentDetailsQuery(id);
  const currentDocId = query.data?.id ?? null;
  const currentDocVersionId = query.data?.currentVersionId ?? null;

  useEffect(() => {
    if (currentDocId === null && currentDocVersionId === null) {
      return;
    }
    setPreviewVersion(null);
  }, [currentDocId, currentDocVersionId]);

  if (query.isLoading) {
    return <LoadingState message={t("documents.details.loading")} />;
  }

  if (query.isError) {
    if (query.error.statusCode === 403) {
      return (
        <Stack spacing={2}>
          <Alert severity="warning" role="alert">
            {t("documents.details.accessDeniedPrefix", { message: query.error.message })}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => void navigate("/documents")}
            >
              {t("documents.details.backToList")}
            </Button>
          </Box>
        </Stack>
      );
    }

    if (query.error.statusCode === 404) {
      return (
        <EmptyState
          title={t("documents.details.notFoundTitle")}
          description={t("documents.details.notFoundDescription")}
          actionLabel={t("documents.details.backToList")}
          onAction={() => void navigate("/documents")}
        />
      );
    }

    return (
      <ErrorState
        title={t("documents.details.loadErrorTitle")}
        description={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const doc = query.data;
  if (!doc) {
    return null;
  }

  const sortedFields = [...doc.category.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const definedKeys = new Set(sortedFields.map((field) => field.key));
  const extraMetadataKeys = Object.keys(doc.metadata).filter((key) => !definedKeys.has(key));
  const emptyDateLabel = t("documents.common.notProvidedFem");

  const handlePreviewVersion = (version: DocumentVersionHistoryItem): void => {
    setPreviewVersion(version.id === doc.currentVersionId ? null : version);
    if (typeof previewSectionRef.current?.scrollIntoView === "function") {
      previewSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <Stack spacing={3}>
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Stack spacing={1}>
          <Button
            variant="text"
            size="small"
            startIcon={<ArrowBackOutlinedIcon />}
            onClick={() => void navigate("/documents")}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("documents.details.backToList")}
          </Button>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
            <DescriptionOutlinedIcon color="primary" />
            <Typography variant="h1">{doc.title}</Typography>
            <Chip
              label={t(`documents.status.${doc.status}`)}
              color={DOCUMENT_STATUS_COLOR[doc.status]}
              size="small"
            />
            {doc.currentVersion ? (
              <Chip
                label={t("documents.details.versionBadge", {
                  version: doc.currentVersion.versionNumber,
                })}
                variant="outlined"
                size="small"
              />
            ) : null}
          </Stack>
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          {doc.permissions.canUpdate && !editingMetadata ? (
            <Button
              variant="outlined"
              startIcon={<EditOutlinedIcon />}
              onClick={() => setEditingMetadata(true)}
            >
              {t("documents.details.editDetails")}
            </Button>
          ) : null}

          <DocumentLifecycleActions
            document={doc}
            onActionFeedback={(feedback) => setLifecycleFeedback(feedback)}
          />

          {doc.permissions.canUpload && doc.status !== "ARCHIVED" && doc.status !== "DELETED" ? (
            <Button
              variant="contained"
              startIcon={<UploadFileOutlinedIcon />}
              onClick={() => setUploadNewVersionOpen(true)}
            >
              {t("documents.details.uploadNewVersion")}
            </Button>
          ) : null}

          {doc.permissions.canUpdate &&
          (doc.status === "DRAFT" || doc.status === "REJECTED" || doc.status === "EXPIRED") &&
          doc.currentVersion?.fileObject?.status === "AVAILABLE" ? (
            <Button
              variant="outlined"
              color="primary"
              startIcon={<SendOutlinedIcon />}
              onClick={() => setStartWorkflowOpen(true)}
            >
              {t("documents.details.sendForApproval")}
            </Button>
          ) : null}
        </Stack>
      </Box>

      {lifecycleFeedback ? (
        <Alert severity={lifecycleFeedback.severity} onClose={() => setLifecycleFeedback(null)}>
          {lifecycleFeedback.message}
        </Alert>
      ) : null}

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Stack spacing={2.5}>
            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                {t("documents.details.summaryHeading")}
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <CategoryOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.details.category")}
                      </Typography>
                    </Stack>
                    <Typography variant="body1" fontWeight={500}>
                      {doc.category.name}
                    </Typography>
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <FolderOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.details.folder")}
                      </Typography>
                    </Stack>
                    {doc.folder ? (
                      <Button
                        variant="text"
                        size="small"
                        sx={{ justifyContent: "flex-start", px: 0, textTransform: "none" }}
                        onClick={() => void navigate(`/folders/${doc.folder?.id}`)}
                      >
                        {doc.folder.name}
                      </Button>
                    ) : (
                      <Typography variant="body1" fontWeight={500}>
                        {t("documents.common.noFolderRoot")}
                      </Typography>
                    )}
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <PersonOutlineOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.details.owner")}
                      </Typography>
                    </Stack>
                    <Typography variant="body1" fontWeight={500}>
                      {doc.owner.fullName}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {doc.owner.email}
                    </Typography>
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <EventOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        {t("documents.details.validity")}
                      </Typography>
                    </Stack>
                    <Typography variant="body2">
                      {t("documents.details.issueDate")}{" "}
                      <strong>
                        {formatIsoCalendarDate(doc.issueDate, formatDate, emptyDateLabel)}
                      </strong>
                    </Typography>
                    <Typography variant="body2">
                      {t("documents.details.expirationDate")}{" "}
                      <strong>
                        {formatIsoCalendarDate(doc.expirationDate, formatDate, emptyDateLabel)}
                      </strong>
                    </Typography>
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t("documents.details.createdAt")}
                  </Typography>
                  <Typography variant="body2">{formatDateTime(doc.createdAt)}</Typography>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography variant="caption" color="text.secondary">
                    {t("documents.details.updatedAt")}
                  </Typography>
                  <Typography variant="body2">{formatDateTime(doc.updatedAt)}</Typography>
                </Grid>
              </Grid>
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                {t("documents.details.customFieldsHeading")}
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {editingMetadata ? (
                <DocumentMetadataForm
                  document={doc}
                  onSaved={() => setEditingMetadata(false)}
                  onCancel={() => setEditingMetadata(false)}
                />
              ) : sortedFields.length === 0 && extraMetadataKeys.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  {t("documents.details.noCustomFields")}
                </Typography>
              ) : (
                <Grid container spacing={2}>
                  {sortedFields.map((field) => (
                    <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {field.label}
                      </Typography>
                      <Typography variant="body1">
                        {formatMetadataValue(doc.metadata[field.key], t, formatDate, formatNumber)}
                      </Typography>
                    </Grid>
                  ))}
                  {extraMetadataKeys.map((extraKey) => (
                    <Grid key={extraKey} size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {extraKey}
                      </Typography>
                      <Typography variant="body1">
                        {formatMetadataValue(doc.metadata[extraKey], t, formatDate, formatNumber)}
                      </Typography>
                    </Grid>
                  ))}
                </Grid>
              )}
            </Paper>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12, lg: 5 }}>
          <Stack spacing={2.5}>
            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                {t("documents.details.currentFileHeading")}
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {doc.currentVersion?.fileObject ? (
                <Stack spacing={2}>
                  <DocumentFileAvailabilityPanel
                    fileStatus={doc.currentVersion.fileObject.status}
                    fileName={doc.currentVersion.fileObject.originalFileName}
                    onUploadNewVersion={
                      doc.permissions.canUpload ? () => setUploadNewVersionOpen(true) : undefined
                    }
                  />
                  <Stack spacing={0.5}>
                    <Typography variant="caption" color="text.secondary">
                      {t("documents.details.fileType")}{" "}
                      <strong>{doc.currentVersion.fileObject.detectedContentType}</strong>
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t("documents.details.fileSize")}{" "}
                      <strong>{formatBytes(doc.currentVersion.fileObject.sizeBytes)}</strong>
                    </Typography>
                  </Stack>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t("documents.details.noFileLinked")}
                </Typography>
              )}
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <DocumentTagsField documentId={doc.id} canEdit={doc.permissions.canUpdate} />
            </Paper>
          </Stack>
        </Grid>

        <Grid ref={previewSectionRef} size={{ xs: 12 }}>
          <DocumentPreviewPanel
            document={doc}
            targetVersion={previewVersion}
            onResetToCurrentVersion={previewVersion ? () => setPreviewVersion(null) : undefined}
          />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <VersionHistory
            document={doc}
            activePreviewVersionId={previewVersion?.id ?? doc.currentVersionId}
            onPreviewVersion={handlePreviewVersion}
            onUploadNewVersion={
              doc.permissions.canUpload ? () => setUploadNewVersionOpen(true) : undefined
            }
          />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <DocumentWorkflowTimeline documentId={doc.id} />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <DocumentCommentsPanel documentId={doc.id} documentStatus={doc.status} />
        </Grid>
      </Grid>

      <UploadDialog
        open={uploadNewVersionOpen}
        documentId={doc.id}
        onUploadBatchFinished={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: documentDetailsQueryKey(doc.id) }),
            queryClient.invalidateQueries({ queryKey: documentVersionsQueryKey(doc.id) }),
          ]);
        }}
        onClose={() => setUploadNewVersionOpen(false)}
      />

      <StartWorkflowDialog
        open={startWorkflowOpen}
        documentId={doc.id}
        documentTitle={doc.title}
        documentVersionNumber={doc.currentVersion?.versionNumber}
        currentVersionId={doc.currentVersionId}
        expectedDocumentVersion={doc.version}
        onStarted={(message) => setLifecycleFeedback({ severity: "success", message })}
        onClose={() => setStartWorkflowOpen(false)}
      />
    </Stack>
  );
}
