import {
  CONTRACTS_API_PREFIX,
  type DocumentWorkflowTimelineInstance,
  type WorkflowDecisionType,
  type WorkflowInstanceStatus,
  type WorkflowTaskStatus,
  type WorkflowTimelineStep,
  apiErrorResponseSchema,
  documentWorkflowTimelineResponseSchema,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState } from "@docuflow/ui";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import HighlightOffOutlinedIcon from "@mui/icons-material/HighlightOffOutlined";
import RadioButtonUncheckedOutlinedIcon from "@mui/icons-material/RadioButtonUncheckedOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import { Alert, Box, Chip, Divider, Paper, Stack, Typography } from "@mui/material";
import { useQuery } from "@tanstack/react-query";

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
  fallbackMessage: string,
): Promise<WorkflowTimelineFetchError> {
  let message = `${fallbackMessage} (${response.status}).`;
  try {
    const rawError: unknown = await response.json();
    const parsed = apiErrorResponseSchema.safeParse(rawError);
    if (parsed.success) {
      message = parsed.data.error.message;
    }
  } catch {
    // Fallback to HTTP status message.
  }
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
    throw await parseTimelineError(
      response,
      "Não foi possível carregar a linha do tempo do processo",
    );
  }

  const rawJson: unknown = await response.json();
  const parsed = documentWorkflowTimelineResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new WorkflowTimelineFetchError(
      500,
      "Resposta inválida recebida ao consultar o histórico do fluxo.",
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
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  ACTIVE: { label: "Em andamento", color: "info" },
  COMPLETED: { label: "Concluído", color: "success" },
  REJECTED: { label: "Rejeitado", color: "error" },
  CHANGES_REQUESTED: { label: "Ajustes solicitados", color: "warning" },
  CANCELLED: { label: "Cancelado", color: "default" },
  EXPIRED: { label: "Expirado", color: "error" },
};

const TASK_STATUS_BADGE: Readonly<
  Record<
    WorkflowTaskStatus,
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  PENDING: { label: "Pendente", color: "info" },
  APPROVED: { label: "Aprovada", color: "success" },
  REJECTED: { label: "Rejeitada", color: "error" },
  CHANGES_REQUESTED: { label: "Ajustes solicitados", color: "warning" },
  CANCELLED: { label: "Cancelada", color: "default" },
  EXPIRED: { label: "Expirada", color: "error" },
};

const DECISION_LABEL: Readonly<Record<WorkflowDecisionType, string>> = {
  APPROVE: "Aprovado",
  REJECT: "Rejeitado",
  REQUEST_CHANGES: "Ajustes solicitados",
};

const ASSIGNEE_TYPE_LABEL: Readonly<Record<WorkflowTimelineStep["assigneeType"], string>> = {
  USER: "Usuário",
  GROUP: "Grupo",
  ROLE: "Papel",
};

function formatDateTimePtBr(isoDateTime: string | null): string | null {
  if (!isoDateTime) {
    return null;
  }
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

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
  const timelineQuery = useDocumentWorkflowTimelineQuery(documentId);

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" mb={1}>
        <Stack direction="row" spacing={1} alignItems="center">
          <AccountTreeOutlinedIcon color="primary" fontSize="small" />
          <Typography variant="h6" component="h2">
            Linha do tempo do processo
          </Typography>
        </Stack>
        <Chip label="Somente leitura" size="small" variant="outlined" />
      </Stack>
      <Divider sx={{ mb: 2 }} />

      {timelineQuery.isLoading ? (
        <Typography variant="body2" color="text.secondary">
          Carregando linha do tempo do processo...
        </Typography>
      ) : timelineQuery.isError ? (
        timelineQuery.error.statusCode === 403 ? (
          <Alert severity="warning" role="alert">
            Acesso restrito ao histórico do fluxo: {timelineQuery.error.message}
          </Alert>
        ) : (
          <ErrorState
            title="Falha ao carregar linha do tempo"
            description={timelineQuery.error.message}
            onRetry={() => void timelineQuery.refetch()}
          />
        )
      ) : !timelineQuery.data || timelineQuery.data.length === 0 ? (
        <EmptyState
          title="Nenhum fluxo de aprovação registrado"
          description="Este documento ainda não possui processos de revisão ou aprovação iniciados no seu escopo."
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
                  border: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
                  bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
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
                      <Chip label={instanceBadge.label} color={instanceBadge.color} size="small" />
                      <Chip
                        label={`Versão avaliada v${instance.documentVersionNumber}`}
                        size="small"
                        variant="outlined"
                      />
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      Iniciado por {instance.startedByDisplayName} em{" "}
                      {formatDateTimePtBr(instance.startedAt)}
                      {instance.completedAt
                        ? ` · Encerrado em ${formatDateTimePtBr(instance.completedAt)}`
                        : ""}
                    </Typography>
                  </Stack>
                </Stack>

                <Box
                  component="ol"
                  aria-label={`Etapas do fluxo ${instance.workflowDefinitionName}`}
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
                    const createdLabel = formatDateTimePtBr(step.createdAt);
                    const dueLabel = formatDateTimePtBr(step.dueAt);
                    const decidedLabel = formatDateTimePtBr(step.decidedAt);

                    return (
                      <Box
                        component="li"
                        key={`${instance.id}-step-${step.stepOrder}`}
                        sx={{
                          p: 1.5,
                          borderRadius: 1,
                          border: `1px solid ${DOCUFLOW_COLOR_TOKENS.surface.outlineVariant}`,
                          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
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
                                Etapa {step.stepOrder}: {step.stepName}
                              </Typography>
                            </Stack>

                            {taskBadge ? (
                              <Chip label={taskBadge.label} color={taskBadge.color} size="small" />
                            ) : (
                              <Chip
                                label="Aguardando etapa anterior"
                                size="small"
                                variant="outlined"
                              />
                            )}
                          </Stack>

                          <Typography variant="body2" color="text.secondary">
                            Responsável: <strong>{step.assigneeDisplayName}</strong> (
                            {ASSIGNEE_TYPE_LABEL[step.assigneeType]})
                          </Typography>

                          {createdLabel || dueLabel || decidedLabel ? (
                            <Typography variant="caption" color="text.secondary">
                              {createdLabel ? `Atribuída em ${createdLabel}` : ""}
                              {createdLabel && dueLabel ? " · " : ""}
                              {dueLabel ? `Prazo: ${dueLabel}` : ""}
                              {(createdLabel || dueLabel) && decidedLabel ? " · " : ""}
                              {decidedLabel ? `Decisão em ${decidedLabel}` : ""}
                            </Typography>
                          ) : null}

                          {step.decision ? (
                            <Box
                              sx={{
                                mt: 0.5,
                                px: 1.5,
                                py: 1,
                                borderRadius: 1,
                                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow,
                              }}
                            >
                              <Typography variant="caption" color="text.primary" fontWeight={600}>
                                {DECISION_LABEL[step.decision.decision]} por{" "}
                                {step.decision.actorDisplayName} em{" "}
                                {formatDateTimePtBr(step.decision.createdAt)}
                              </Typography>
                              {step.decision.comment ? (
                                <Typography
                                  variant="body2"
                                  color="text.secondary"
                                  sx={{ mt: 0.25 }}
                                >
                                  Comentário: “{step.decision.comment}”
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
