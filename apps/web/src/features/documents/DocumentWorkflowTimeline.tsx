import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import HighlightOffOutlinedIcon from "@mui/icons-material/HighlightOffOutlined";
import RadioButtonUncheckedOutlinedIcon from "@mui/icons-material/RadioButtonUncheckedOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import { Alert, Box, Chip, Divider, Paper, Stack, Typography } from "@mui/material";
import {
  CONTRACTS_API_PREFIX,
  type DocumentWorkflowTimelineInstance,
  type WorkflowDecisionType,
  type WorkflowInstanceStatus,
  type WorkflowTaskStatus,
  type WorkflowTimelineStep,
  apiErrorResponseSchema,
  documentWorkflowTimelineResponseSchema,
} from "@papyrus/contracts";
import { EmptyState, ErrorState, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useQuery } from "@tanstack/react-query";
import { getLocalizedApiErrorMessage } from "../../i18n/api-errors.js";
import { type MessageKey, translate, useI18n } from "../../i18n/index.js";

export class WorkflowTimelineFetchError extends Error {
  public readonly statusCode: number;

  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "WorkflowTimelineFetchError";
    this.statusCode = statusCode;
  }
}

export function documentWorkflowTimelineQueryKey(documentId: string) {
  return ["documents", documentId, "workflow-timeline"] as const;
}

async function parseTimelineError(
  response: Response,
  fallbackKey: MessageKey,
): Promise<WorkflowTimelineFetchError> {
  let serverMessage: string | undefined;
  let code: string | undefined;
  try {
    const rawError: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawError);
    if (parsed.success) {
      serverMessage = parsed.data.error.message;
      code = parsed.data.error.code;
    }
  } catch {
    // Non-JSON response falls through to localized status/fallback message.
  }

  const hasKnownStatus =
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404 ||
    response.status === 429;
  const message =
    code || hasKnownStatus
      ? getLocalizedApiErrorMessage(code, response.status, serverMessage)
      : translate(fallbackKey);

  return new WorkflowTimelineFetchError(response.status, message);
}

/**
 * Fetches read-only workflow timeline instances bound to an authorized document.
 * Returns null when the timeline endpoint or resource is unavailable (404/501).
 */
export async function fetchDocumentWorkflowTimeline(
  documentId: string,
  signal?: AbortSignal,
): Promise<readonly DocumentWorkflowTimelineInstance[] | null> {
  const response = await fetch(
    `${CONTRACTS_API_PREFIX}/documents/${encodeURIComponent(documentId)}/workflows`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    },
  );

  if (response.status === 404 || response.status === 501) {
    return null;
  }

  if (!response.ok) {
    throw await parseTimelineError(response, "workflows.errors.loadTimeline");
  }

  const rawJson: unknown = await response.json();
  const parsed = documentWorkflowTimelineResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new WorkflowTimelineFetchError(
      500,
      translate("workflows.errors.invalidTimelineResponse"),
    );
  }

  return parsed.data.data;
}

export function useDocumentWorkflowTimelineQuery(documentId: string) {
  return useQuery<readonly DocumentWorkflowTimelineInstance[] | null, WorkflowTimelineFetchError>({
    queryKey: documentWorkflowTimelineQueryKey(documentId),
    queryFn: ({ signal }) => fetchDocumentWorkflowTimeline(documentId, signal),
    enabled: documentId.trim().length > 0,
    retry: false,
  });
}

const INSTANCE_STATUS_BADGE: Readonly<
  Record<
    WorkflowInstanceStatus,
    {
      readonly key: MessageKey;
      readonly color: "default" | "info" | "success" | "warning" | "error";
    }
  >
> = {
  ACTIVE: { key: "workflows.instanceStatus.ACTIVE", color: "info" },
  COMPLETED: { key: "workflows.instanceStatus.COMPLETED", color: "success" },
  REJECTED: { key: "workflows.instanceStatus.REJECTED", color: "error" },
  CHANGES_REQUESTED: { key: "workflows.instanceStatus.CHANGES_REQUESTED", color: "warning" },
  CANCELLED: { key: "workflows.instanceStatus.CANCELLED", color: "default" },
  EXPIRED: { key: "workflows.instanceStatus.EXPIRED", color: "error" },
};

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

const DECISION_LABEL_KEY: Readonly<Record<WorkflowDecisionType, MessageKey>> = {
  APPROVE: "workflows.decision.APPROVE",
  REJECT: "workflows.decision.REJECT",
  REQUEST_CHANGES: "workflows.decision.REQUEST_CHANGES",
};

const ASSIGNEE_TYPE_KEY: Readonly<Record<WorkflowTimelineStep["assigneeType"], MessageKey>> = {
  USER: "workflows.assigneeType.USER",
  GROUP: "workflows.assigneeType.GROUP",
  ROLE: "workflows.assigneeType.ROLE",
};

function renderStepStatusIcon(step: WorkflowTimelineStep) {
  switch (step.taskStatus) {
    case "APPROVED":
      return <CheckCircleOutlineOutlinedIcon fontSize="small" color="success" />;
    case "REJECTED":
    case "EXPIRED":
      return <HighlightOffOutlinedIcon fontSize="small" color="error" />;
    case "CHANGES_REQUESTED":
      return <EditNoteOutlinedIcon fontSize="small" color="warning" />;
    case "PENDING":
      return <ScheduleOutlinedIcon fontSize="small" color="info" />;
    default:
      return <RadioButtonUncheckedOutlinedIcon fontSize="small" color="action" />;
  }
}

export interface DocumentWorkflowTimelineProps {
  readonly documentId: string;
}

/**
 * Read-only workflow process timeline panel for document detail view, displaying
 * ordered stages, responsible assignees, recorded decisions, and timestamps for
 * authorized users.
 */
export function DocumentWorkflowTimeline({ documentId }: DocumentWorkflowTimelineProps) {
  const { t, formatDateTime } = useI18n();
  const timelineQuery = useDocumentWorkflowTimelineQuery(documentId);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" mb={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <AccountTreeOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="h6" component="h2">
            {t("workflows.timeline.title")}
          </Typography>
        </Stack>
        <Chip label={t("workflows.timeline.readOnly")} size="small" variant="outlined" />
      </Stack>
      <Divider sx={{ mb: 2 }} />

      {timelineQuery.isLoading ? (
        <Typography variant="body2" color="text.secondary">
          {t("workflows.timeline.loading")}
        </Typography>
      ) : timelineQuery.isError ? (
        timelineQuery.error.statusCode === 403 ? (
          <Alert severity="warning" role="alert">
            {t("workflows.timeline.accessRestricted", {
              message: timelineQuery.error.message,
            })}
          </Alert>
        ) : (
          <ErrorState
            title={t("workflows.timeline.errorTitle")}
            description={timelineQuery.error.message}
            onRetry={() => void timelineQuery.refetch()}
          />
        )
      ) : !timelineQuery.data || timelineQuery.data.length === 0 ? (
        <EmptyState
          title={t("workflows.timeline.emptyTitle")}
          description={t("workflows.timeline.emptyDescription")}
        />
      ) : (
        <Stack spacing={2.5}>
          {timelineQuery.data.map((instance) => {
            const instanceBadge = INSTANCE_STATUS_BADGE[instance.status];
            const orderedSteps = [...instance.steps].sort((a, b) => a.stepOrder - b.stepOrder);

            return (
              <Box
                key={instance.id}
                sx={{
                  p: 2,
                  borderRadius: 1,
                  border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                  bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                }}
              >
                <Stack
                  direction={{ xs: "column", sm: "row" }}
                  spacing={1}
                  justifyContent="space-between"
                  alignItems={{ xs: "flex-start", sm: "center" }}
                  mb={1.5}
                >
                  <Stack spacing={0.25}>
                    <Stack
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      flexWrap="wrap"
                      useFlexGap
                    >
                      <Typography variant="subtitle1">
                        {instance.workflowDefinitionName} (v
                        {instance.workflowDefinitionVersionNumber})
                      </Typography>
                      <Chip label={t(instanceBadge.key)} color={instanceBadge.color} size="small" />
                      <Chip
                        label={t("workflows.timeline.evaluatedVersion", {
                          version: instance.documentVersionNumber,
                        })}
                        size="small"
                        variant="outlined"
                      />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {t("workflows.timeline.startedBy", {
                        user: instance.startedByDisplayName,
                        date: formatDateTime(instance.startedAt),
                      })}
                      {instance.completedAt
                        ? t("workflows.timeline.completedOn", {
                            date: formatDateTime(instance.completedAt),
                          })
                        : ""}
                    </Typography>
                  </Stack>
                </Stack>

                <Box
                  component="ol"
                  aria-label={t("workflows.timeline.stepsListAria", {
                    name: instance.workflowDefinitionName,
                  })}
                  sx={{
                    m: 0,
                    p: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 1.25,
                  }}
                >
                  {orderedSteps.map((step) => {
                    const taskBadge = step.taskStatus ? TASK_STATUS_BADGE[step.taskStatus] : null;
                    const createdLabel = step.createdAt ? formatDateTime(step.createdAt) : null;
                    const dueLabel = step.dueAt ? formatDateTime(step.dueAt) : null;
                    const decidedLabel = step.decidedAt ? formatDateTime(step.decidedAt) : null;

                    return (
                      <Box
                        component="li"
                        key={`${instance.id}-step-${step.stepOrder}`}
                        sx={{
                          p: 1.5,
                          borderRadius: 1,
                          border: `1px solid ${PAPYRUS_COLOR_TOKENS.surface.outlineVariant}`,
                          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
                        }}
                      >
                        <Stack spacing={0.75}>
                          <Stack
                            direction={{ xs: "column", sm: "row" }}
                            spacing={1}
                            justifyContent="space-between"
                            alignItems={{ xs: "flex-start", sm: "center" }}
                          >
                            <Stack direction="row" spacing={1} alignItems="center">
                              {renderStepStatusIcon(step)}
                              <Typography variant="body2" fontWeight={600}>
                                {t("workflows.timeline.stepTitle", {
                                  order: step.stepOrder,
                                  name: step.stepName,
                                })}
                              </Typography>
                            </Stack>

                            {taskBadge ? (
                              <Chip label={t(taskBadge.key)} color={taskBadge.color} size="small" />
                            ) : (
                              <Chip
                                label={t("workflows.timeline.waitingPreviousStep")}
                                size="small"
                                variant="outlined"
                              />
                            )}
                          </Stack>

                          <Typography variant="body2" color="text.secondary">
                            {t("workflows.timeline.assigneeLabel")}{" "}
                            <strong>{step.assigneeDisplayName}</strong> (
                            {t(ASSIGNEE_TYPE_KEY[step.assigneeType])})
                          </Typography>

                          {createdLabel || dueLabel || decidedLabel ? (
                            <Typography variant="caption" color="text.secondary">
                              {createdLabel
                                ? t("workflows.timeline.assignedOn", { date: createdLabel })
                                : ""}
                              {createdLabel && dueLabel ? " · " : ""}
                              {dueLabel ? t("workflows.timeline.dueOn", { date: dueLabel }) : ""}
                              {(createdLabel || dueLabel) && decidedLabel ? " · " : ""}
                              {decidedLabel
                                ? t("workflows.timeline.decidedOn", { date: decidedLabel })
                                : ""}
                            </Typography>
                          ) : null}

                          {step.decision ? (
                            <Box
                              sx={{
                                mt: 0.5,
                                px: 1.5,
                                py: 1,
                                borderRadius: 1,
                                bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLow,
                              }}
                            >
                              <Typography variant="caption" color="text.primary" fontWeight={600}>
                                {t("workflows.timeline.decisionSummary", {
                                  decision: t(DECISION_LABEL_KEY[step.decision.decision]),
                                  actor: step.decision.actorDisplayName,
                                  date: formatDateTime(step.decision.createdAt),
                                })}
                              </Typography>
                              {step.decision.comment ? (
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{ mt: 0.25 }}
                                >
                                  {t("workflows.timeline.decisionComment", {
                                    comment: step.decision.comment,
                                  })}
                                </Typography>
                              ) : null}
                            </Box>
                          ) : null}
                        </Stack>
                      </Box>
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
}
