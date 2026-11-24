import type {
  DocumentMetadataValue,
  DocumentStatus,
  SubmitTaskDecisionResult,
  WorkflowDecisionType,
  WorkflowTaskStatus,
} from "@docuflow/contracts";
import { EmptyState, ErrorState, LoadingState, PAPYRUS_COLOR_TOKENS } from "@docuflow/ui";
import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import HighlightOffOutlinedIcon from "@mui/icons-material/HighlightOffOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  Grid,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import { DocumentFileAvailabilityPanel } from "../documents/FileProcessingStatus.js";
import { resolveTaskDocumentTarget } from "./useTaskInbox.js";
import {
  useSubmitTaskDecisionMutation,
  useTaskDetailQuery,
  useTaskDocumentDetailsQuery,
  useTaskDocumentVersionsQuery,
} from "./useTaskReview.js";

const TASK_STATUS_BADGE: Readonly<
  Record<
    WorkflowTaskStatus,
    {
      readonly key: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  PENDING: { key: "workflows.taskStatus.PENDING", color: "info" },
  APPROVED: { key: "workflows.taskStatus.APPROVED", color: "success" },
  REJECTED: { key: "workflows.taskStatus.REJECTED", color: "error" },
  CHANGES_REQUESTED: { key: "workflows.taskStatus.CHANGES_REQUESTED", color: "warning" },
  CANCELLED: { key: "workflows.taskStatus.CANCELLED", color: "default" },
  EXPIRED: { key: "workflows.taskStatus.EXPIRED", color: "error" },
};

const DOCUMENT_STATUS_BADGE: Readonly<
  Record<
    DocumentStatus,
    {
      readonly key: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  DRAFT: { key: "workflows.documentStatus.DRAFT", color: "default" },
  IN_REVIEW: { key: "workflows.documentStatus.IN_REVIEW", color: "info" },
  APPROVED: { key: "workflows.documentStatus.APPROVED", color: "success" },
  REJECTED: { key: "workflows.documentStatus.REJECTED", color: "error" },
  ARCHIVED: { key: "workflows.documentStatus.ARCHIVED", color: "default" },
  EXPIRED: { key: "workflows.documentStatus.EXPIRED", color: "warning" },
  DELETED: { key: "workflows.documentStatus.DELETED", color: "error" },
};

const DECISION_LABEL_KEY: Readonly<Record<WorkflowDecisionType, MessageKey>> = {
  APPROVE: "tasks.review.decisionRecorded.APPROVE",
  REJECT: "tasks.review.decisionRecorded.REJECT",
  REQUEST_CHANGES: "tasks.review.decisionRecorded.REQUEST_CHANGES",
};

function parseIsoCalendarDate(isoDate: string): Date | string {
  const [yearRaw, monthRaw, dayRaw] = isoDate.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return isoDate;
  }
  return new Date(year, month - 1, day);
}

/**
 * Authorized workflow task review detail page displaying the bound document
 * version, metadata, version/task history, and guarded approval actions.
 */
export function TaskReviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { t, formatDate, formatDateTime, formatNumber, formatBytes } = useI18n();

  const [comment, setComment] = useState("");
  const [commentValidationError, setCommentValidationError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<WorkflowDecisionType | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmedDecision, setConfirmedDecision] = useState<SubmitTaskDecisionResult | null>(null);

  const taskQuery = useTaskDetailQuery(id);
  const task = taskQuery.data;

  const documentQuery = useTaskDocumentDetailsQuery(task?.documentId);
  const versionsQuery = useTaskDocumentVersionsQuery(task?.documentId);
  const decisionMutation = useSubmitTaskDecisionMutation(id, task?.documentId);

  const formatIsoDate = (isoDate: string | null): string => {
    if (!isoDate) {
      return t("tasks.review.notProvidedFem");
    }
    return formatDate(parseIsoCalendarDate(isoDate), t("tasks.review.notProvidedFem"));
  };

  const formatMetadataValue = (value: DocumentMetadataValue | undefined): string => {
    if (value === undefined || value === null) {
      return t("tasks.review.notProvided");
    }
    if (typeof value === "boolean") {
      return value ? t("tasks.review.yes") : t("tasks.review.no");
    }
    if (Array.isArray(value)) {
      return value.length > 0 ? value.join(", ") : t("tasks.review.noneSelected");
    }
    if (typeof value === "number") {
      return formatNumber(value);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return formatIsoDate(value);
    }
    return value.trim().length > 0 ? value : t("tasks.review.notProvided");
  };

  if (taskQuery.isLoading) {
    return <LoadingState message={t("tasks.review.loading")} />;
  }

  if (taskQuery.isError) {
    if (taskQuery.error.statusCode === 403) {
      return (
        <Stack spacing={2}>
          <Alert severity="warning" role="alert">
            {t("tasks.review.accessDenied", { message: taskQuery.error.message })}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => void navigate("/tasks")}
            >
              {t("tasks.review.backToInbox")}
            </Button>
          </Box>
        </Stack>
      );
    }

    if (taskQuery.error.statusCode === 404) {
      return (
        <EmptyState
          title={t("tasks.review.notFoundTitle")}
          description={t("tasks.review.notFoundDescription")}
          actionLabel={t("tasks.review.backToInbox")}
          onAction={() => void navigate("/tasks")}
        />
      );
    }

    return (
      <ErrorState
        title={t("tasks.review.errorTitle")}
        description={taskQuery.error.message}
        onRetry={() => void taskQuery.refetch()}
      />
    );
  }

  if (!task) {
    return null;
  }

  const taskBadge = TASK_STATUS_BADGE[task.status];
  const documentBadge = DOCUMENT_STATUS_BADGE[task.documentStatus];
  const documentTarget = resolveTaskDocumentTarget(task);

  const versions = versionsQuery.data ?? [];
  const exactBoundVersion = versions.find((item) => item.id === task.documentVersionId) ?? null;

  const doc = documentQuery.data ?? null;
  const sortedFields = doc
    ? [...doc.category.fields].sort((a, b) => a.sortOrder - b.sortOrder)
    : [];
  const definedFieldKeys = new Set(sortedFields.map((field) => field.key));
  const extraMetadataKeys = doc
    ? Object.keys(doc.metadata).filter((key) => !definedFieldKeys.has(key))
    : [];

  const hasNewerDocumentVersion =
    doc?.currentVersion !== null &&
    doc?.currentVersion !== undefined &&
    doc.currentVersion.id !== task.documentVersionId;

  const isPendingTask = task.status === "PENDING";
  const isSubmitting = decisionMutation.isPending;

  const isCommentRequiredForAction = (decision: WorkflowDecisionType): boolean => {
    if (decision === "REJECT" || decision === "REQUEST_CHANGES") {
      return true;
    }
    return task.commentRules.requireOnApprove;
  };

  const handleSubmitDecision = async (decision: WorkflowDecisionType): Promise<void> => {
    if (!isPendingTask || isSubmitting) {
      return;
    }

    const trimmedComment = comment.trim();
    if (isCommentRequiredForAction(decision) && trimmedComment.length === 0) {
      setCommentValidationError(
        decision === "APPROVE"
          ? t("tasks.review.validation.commentRequiredApprove")
          : t("tasks.review.validation.commentRequiredRejectOrChanges"),
      );
      return;
    }

    setCommentValidationError(null);
    setSubmitError(null);
    setPendingAction(decision);

    try {
      const result = await decisionMutation.mutateAsync({
        decision,
        comment: trimmedComment.length > 0 ? trimmedComment : null,
      });
      setConfirmedDecision(result);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t("tasks.errors.submitDecision"));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Stack spacing={3}>
      <Box
        sx={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 2,
          flexWrap: "wrap",
        }}
      >
        <Stack spacing={1}>
          <Button
            variant="text"
            size="small"
            startIcon={<ArrowBackOutlinedIcon />}
            onClick={() => void navigate("/tasks")}
            sx={{ alignSelf: "flex-start" }}
          >
            {t("tasks.review.backToInbox")}
          </Button>

          <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h1">
              {t("tasks.review.headerTitle", {
                workflow: task.workflowDefinitionName,
                order: task.stepOrder,
              })}
            </Typography>
            <Chip label={t(taskBadge.key)} color={taskBadge.color} size="small" />
            {task.isOverdue && isPendingTask ? (
              <Chip
                icon={<WarningAmberOutlinedIcon fontSize="small" />}
                label={t("tasks.review.overdue")}
                color="error"
                size="small"
              />
            ) : null}
          </Stack>

          <Typography variant="body1" color="text.secondary">
            {t("tasks.review.headerSubtitlePrefix", { stepName: task.stepName })}{" "}
            <strong>{task.documentTitle}</strong>{" "}
            {t("tasks.review.headerSubtitleVersion", { version: task.documentVersionNumber })}
          </Typography>
        </Stack>

        <Box>
          {documentTarget ? (
            <Button
              variant="outlined"
              endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
              onClick={() => void navigate(documentTarget)}
            >
              {t("tasks.review.openDocument")}
            </Button>
          ) : (
            <Button variant="outlined" disabled>
              {t("tasks.review.documentUnavailable")}
            </Button>
          )}
        </Box>
      </Box>

      {hasNewerDocumentVersion && doc?.currentVersion ? (
        <Alert severity="warning" role="alert">
          {t("tasks.review.newerVersionWarningPrefix", {
            version: doc.currentVersion.versionNumber,
          })}{" "}
          <strong>
            {t("tasks.review.newerVersionWarningVersion", {
              version: task.documentVersionNumber,
            })}
          </strong>{" "}
          {t("tasks.review.newerVersionWarningSuffix")}
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
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="space-between"
                mb={1}
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <VerifiedOutlinedIcon color="primary" fontSize="small" />
                  <Typography variant="h6" component="h2">
                    {t("tasks.review.boundVersionTitle")}
                  </Typography>
                </Stack>
                <Chip
                  label={t("tasks.review.versionChip", { version: task.documentVersionNumber })}
                  color="primary"
                  size="small"
                />
              </Stack>
              <Divider sx={{ mb: 2 }} />

              {versionsQuery.isLoading ? (
                <Typography variant="body2" color="text.secondary">
                  {t("tasks.review.loadingVersion")}
                </Typography>
              ) : versionsQuery.isError ? (
                <ErrorState
                  title={t("tasks.review.versionErrorTitle")}
                  description={versionsQuery.error.message}
                  onRetry={() => void versionsQuery.refetch()}
                />
              ) : exactBoundVersion ? (
                <Stack spacing={2}>
                  {exactBoundVersion.fileObject ? (
                    <DocumentFileAvailabilityPanel
                      fileStatus={exactBoundVersion.fileObject.status}
                      fileName={exactBoundVersion.fileObject.originalFileName}
                    />
                  ) : (
                    <Alert severity="info">{t("tasks.review.noAttachedFile")}</Alert>
                  )}

                  <Grid container spacing={1.5}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.versionAuthor")}
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {exactBoundVersion.uploadedByUser.fullName}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.recordedAt")}
                      </Typography>
                      <Typography variant="body2">
                        {formatDateTime(exactBoundVersion.createdAt, t("tasks.review.notProvided"))}
                      </Typography>
                    </Grid>
                    {exactBoundVersion.fileObject ? (
                      <>
                        <Grid size={{ xs: 12, sm: 6 }}>
                          <Typography variant="caption" color="text.secondary">
                            {t("tasks.review.fileType")}
                          </Typography>
                          <Typography variant="body2">
                            {exactBoundVersion.fileObject.detectedContentType}
                          </Typography>
                        </Grid>
                        <Grid size={{ xs: 12, sm: 6 }}>
                          <Typography variant="caption" color="text.secondary">
                            {t("tasks.review.fileSize")}
                          </Typography>
                          <Typography variant="body2">
                            {formatBytes(exactBoundVersion.fileObject.sizeBytes)}
                          </Typography>
                        </Grid>
                        <Grid size={{ xs: 12 }}>
                          <Typography variant="caption" color="text.secondary">
                            {t("tasks.review.verificationCode")}
                          </Typography>
                          <Typography
                            variant="body2"
                            sx={{ fontFamily: "monospace", wordBreak: "break-all" }}
                          >
                            {exactBoundVersion.fileObject.checksumSha256}
                          </Typography>
                        </Grid>
                      </>
                    ) : null}
                    <Grid size={{ xs: 12 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.versionNote")}
                      </Typography>
                      <Typography variant="body2">
                        {exactBoundVersion.changeNote ?? t("tasks.review.noVersionNote")}
                      </Typography>
                    </Grid>
                  </Grid>
                </Stack>
              ) : (
                <Alert severity="warning">{t("tasks.review.boundVersionMissing")}</Alert>
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
              <Stack
                direction="row"
                spacing={1}
                alignItems="center"
                justifyContent="space-between"
                mb={1}
              >
                <Typography variant="h6" component="h2">
                  {t("tasks.review.metadataTitle")}
                </Typography>
                <Chip label={t(documentBadge.key)} color={documentBadge.color} size="small" />
              </Stack>
              <Divider sx={{ mb: 2 }} />

              {documentQuery.isLoading ? (
                <Typography variant="body2" color="text.secondary">
                  {t("tasks.review.loadingMetadata")}
                </Typography>
              ) : documentQuery.isError ? (
                <Alert severity="warning" role="alert">
                  {t("tasks.review.metadataError", { message: documentQuery.error.message })}
                </Alert>
              ) : doc ? (
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.categoryLabel")}
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.category.name}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.folderLabel")}
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.folder ? doc.folder.name : t("tasks.review.noFolder")}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.ownerLabel")}
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.owner.fullName}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {t("tasks.review.datesLabel")}
                      </Typography>
                      <Typography variant="body2">
                        {t("tasks.review.datesSummary", {
                          issueDate: formatIsoDate(doc.issueDate),
                          expirationDate: formatIsoDate(doc.expirationDate),
                        })}
                      </Typography>
                    </Grid>
                  </Grid>

                  {sortedFields.length > 0 || extraMetadataKeys.length > 0 ? (
                    <>
                      <Divider />
                      <Grid container spacing={2}>
                        {sortedFields.map((field) => (
                          <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                            <Typography variant="caption" color="text.secondary">
                              {field.label}
                            </Typography>
                            <Typography variant="body2">
                              {formatMetadataValue(doc.metadata[field.key])}
                            </Typography>
                          </Grid>
                        ))}
                        {extraMetadataKeys.map((extraKey) => (
                          <Grid key={extraKey} size={{ xs: 12, sm: 6 }}>
                            <Typography variant="caption" color="text.secondary">
                              {extraKey}
                            </Typography>
                            <Typography variant="body2">
                              {formatMetadataValue(doc.metadata[extraKey])}
                            </Typography>
                          </Grid>
                        ))}
                      </Grid>
                    </>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      {t("tasks.review.noCustomMetadata")}
                    </Typography>
                  )}

                  {doc.tags.length > 0 ? (
                    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                      {doc.tags.map((tag) => (
                        <Chip key={tag.id} label={tag.name} size="small" variant="outlined" />
                      ))}
                    </Stack>
                  ) : null}
                </Stack>
              ) : null}
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
                {t("tasks.review.decisionSectionTitle")}
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {confirmedDecision ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {confirmedDecision.decision
                    ? t(DECISION_LABEL_KEY[confirmedDecision.decision.decision])
                    : t("tasks.review.decisionSaved")}
                  {confirmedDecision.idempotentReplay
                    ? t("tasks.review.alreadyRecordedSuffix")
                    : ""}
                  .
                </Alert>
              ) : null}

              {submitError ? (
                <Alert severity="error" role="alert" sx={{ mb: 2 }}>
                  {submitError}
                </Alert>
              ) : null}

              {isPendingTask ? (
                <Stack spacing={2}>
                  <TextField
                    id="task-decision-comment"
                    label={t("tasks.review.commentLabel")}
                    multiline
                    minRows={3}
                    maxRows={6}
                    fullWidth
                    disabled={isSubmitting}
                    value={comment}
                    onChange={(event) => {
                      setComment(event.target.value);
                      if (commentValidationError) {
                        setCommentValidationError(null);
                      }
                    }}
                    error={Boolean(commentValidationError)}
                    helperText={
                      commentValidationError ??
                      (task.commentRules.requireOnApprove
                        ? t("tasks.review.commentRequiredOnApproveHelper")
                        : t("tasks.review.commentOptionalOnApproveHelper"))
                    }
                    slotProps={{
                      htmlInput: {
                        maxLength: 2000,
                      },
                    }}
                  />

                  <Stack direction="column" spacing={1.25}>
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      disabled={isSubmitting}
                      startIcon={<CheckCircleOutlineOutlinedIcon />}
                      onClick={() => void handleSubmitDecision("APPROVE")}
                    >
                      {isSubmitting && pendingAction === "APPROVE"
                        ? t("tasks.review.actions.approving")
                        : t("tasks.review.actions.approve")}
                    </Button>

                    <Button
                      variant="outlined"
                      color="warning"
                      fullWidth
                      disabled={isSubmitting}
                      startIcon={<EditNoteOutlinedIcon />}
                      onClick={() => void handleSubmitDecision("REQUEST_CHANGES")}
                    >
                      {isSubmitting && pendingAction === "REQUEST_CHANGES"
                        ? t("tasks.review.actions.requestingChanges")
                        : t("tasks.review.actions.requestChanges")}
                    </Button>

                    <Button
                      variant="outlined"
                      color="error"
                      fullWidth
                      disabled={isSubmitting}
                      startIcon={<HighlightOffOutlinedIcon />}
                      onClick={() => void handleSubmitDecision("REJECT")}
                    >
                      {isSubmitting && pendingAction === "REJECT"
                        ? t("tasks.review.actions.rejecting")
                        : t("tasks.review.actions.reject")}
                    </Button>
                  </Stack>
                </Stack>
              ) : (
                <Alert severity="info">
                  {t("tasks.review.completedPrefix")} <strong>{t(taskBadge.key)}</strong>
                  {task.decidedAt
                    ? ` ${t("tasks.review.completedAt", {
                        date: formatDateTime(task.decidedAt),
                      })}`
                    : ""}
                  {t("tasks.review.completedSuffix")}
                </Alert>
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
              <Stack direction="row" spacing={1} alignItems="center" mb={1}>
                <HistoryOutlinedIcon color="action" fontSize="small" />
                <Typography variant="h6" component="h2">
                  {t("tasks.review.historyTitle")}
                </Typography>
              </Stack>
              <Divider sx={{ mb: 1.5 }} />

              <List dense disablePadding>
                <ListItem divider disableGutters>
                  <ListItemText
                    primary={t("tasks.review.historyAssigned", { stepName: task.stepName })}
                    secondary={`${t("tasks.review.historyCreatedAt", {
                      date: formatDateTime(task.createdAt, t("tasks.review.notProvided")),
                    })}${
                      task.dueAt
                        ? t("tasks.review.historyDueAt", {
                            date: formatDateTime(task.dueAt),
                          })
                        : ""
                    }`}
                  />
                </ListItem>

                {task.decidedAt ? (
                  <ListItem divider disableGutters>
                    <ListItemText
                      primary={t("tasks.review.historyFinalState", { status: t(taskBadge.key) })}
                      secondary={`${t("tasks.review.historyConfirmedAt", {
                        date: formatDateTime(task.decidedAt),
                      })}${
                        confirmedDecision?.decision?.comment
                          ? t("tasks.review.historyComment", {
                              comment: confirmedDecision.decision.comment,
                            })
                          : ""
                      }`}
                    />
                  </ListItem>
                ) : null}

                {versions.map((version) => {
                  const isBoundVersion = version.id === task.documentVersionId;
                  return (
                    <ListItem key={version.id} divider disableGutters>
                      <ListItemText
                        primary={
                          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                            <Typography variant="body2" fontWeight={isBoundVersion ? 600 : 500}>
                              {t("tasks.review.versionChip", { version: version.versionNumber })}
                            </Typography>
                            {isBoundVersion ? (
                              <Chip
                                label={t("tasks.review.historyEvaluatedBadge")}
                                color="primary"
                                size="small"
                              />
                            ) : null}
                          </Stack>
                        }
                        secondary={`${version.uploadedByUser.fullName} · ${formatDateTime(
                          version.createdAt,
                        )}${version.changeNote ? ` · ${version.changeNote}` : ""}`}
                      />
                    </ListItem>
                  );
                })}
              </List>
            </Paper>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
