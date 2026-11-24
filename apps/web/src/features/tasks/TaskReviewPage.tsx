import type {
  DocumentMetadataValue,
  DocumentStatus,
  SubmitTaskDecisionResult,
  WorkflowDecisionType,
  WorkflowTaskStatus,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
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

const DOCUMENT_STATUS_BADGE: Readonly<
  Record<
    DocumentStatus,
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  DRAFT: { label: "Rascunho", color: "default" },
  IN_REVIEW: { label: "Em revisão", color: "info" },
  APPROVED: { label: "Aprovado", color: "success" },
  REJECTED: { label: "Rejeitado", color: "error" },
  ARCHIVED: { label: "Arquivado", color: "default" },
  EXPIRED: { label: "Expirado", color: "warning" },
  DELETED: { label: "Excluído", color: "error" },
};

const DECISION_LABEL: Readonly<Record<WorkflowDecisionType, string>> = {
  APPROVE: "Aprovação registrada",
  REJECT: "Rejeição registrada",
  REQUEST_CHANGES: "Solicitação de ajustes registrada",
};

function formatIsoDatePtBr(isoDate: string | null): string {
  if (!isoDate) {
    return "Não informada";
  }
  const [year, month, day] = isoDate.split("-");
  if (!year || !month || !day) {
    return isoDate;
  }
  return `${day}/${month}/${year}`;
}

function formatDateTimePtBr(isoDateTime: string | null, fallback = "Não informado"): string {
  if (!isoDateTime) {
    return fallback;
  }
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

function formatMetadataValue(value: DocumentMetadataValue | undefined): string {
  if (value === undefined || value === null) {
    return "Não informado";
  }
  if (typeof value === "boolean") {
    return value ? "Sim" : "Não";
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "Nenhum item selecionado";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return formatIsoDatePtBr(value);
  }
  return value.trim().length > 0 ? value : "Não informado";
}

function formatFileSizePtBr(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Authorized workflow task review detail page displaying the immutable bound document
 * version, metadata, version/task history, and guarded approval actions in pt-BR.
 */
export function TaskReviewPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();

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

  if (taskQuery.isLoading) {
    return <LoadingState message="Carregando detalhes da tarefa..." />;
  }

  if (taskQuery.isError) {
    if (taskQuery.error.statusCode === 403) {
      return (
        <Stack spacing={2}>
          <Alert severity="warning" role="alert">
            Acesso negado: {taskQuery.error.message}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => void navigate("/tasks")}
            >
              Voltar para Minhas tarefas
            </Button>
          </Box>
        </Stack>
      );
    }

    if (taskQuery.error.statusCode === 404) {
      return (
        <EmptyState
          title="Tarefa não encontrada"
          description="A tarefa solicitada não existe ou não está disponível no seu escopo de acesso."
          actionLabel="Voltar para Minhas tarefas"
          onAction={() => void navigate("/tasks")}
        />
      );
    }

    return (
      <ErrorState
        title="Não foi possível carregar a tarefa"
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
          ? "Esta etapa exige comentário para aprovar."
          : "Informe um comentário justificando a rejeição ou solicitação de ajustes.",
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
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Não foi possível confirmar a decisão desta tarefa.",
      );
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
            Voltar para Minhas tarefas
          </Button>

          <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h1">
              {task.workflowDefinitionName} — Etapa {task.stepOrder}
            </Typography>
            <Chip label={taskBadge.label} color={taskBadge.color} size="small" />
            {task.isOverdue && isPendingTask ? (
              <Chip
                icon={<WarningAmberOutlinedIcon fontSize="small" />}
                label="Em atraso"
                color="error"
                size="small"
              />
            ) : null}
          </Stack>

          <Typography variant="body1" color="text.secondary">
            {task.stepName} · Documento: <strong>{task.documentTitle}</strong> (Versão v
            {task.documentVersionNumber})
          </Typography>
        </Stack>

        <Box>
          {documentTarget ? (
            <Button
              variant="outlined"
              endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
              onClick={() => void navigate(documentTarget)}
            >
              Abrir documento
            </Button>
          ) : (
            <Button variant="outlined" disabled>
              Documento indisponível
            </Button>
          )}
        </Box>
      </Box>

      {hasNewerDocumentVersion && doc?.currentVersion ? (
        <Alert severity="warning" role="alert">
          Atenção: este documento já possui uma versão vigente mais recente (v
          {doc.currentVersion.versionNumber}). Esta decisão avalia exclusivamente a{" "}
          <strong>versão v{task.documentVersionNumber}</strong> vinculada à tarefa.
        </Alert>
      ) : null}

      <Grid container spacing={2.5}>
        <Grid size={{ xs: 12, lg: 7 }}>
          <Stack spacing={2.5}>
            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                    Versão exata vinculada à tarefa
                  </Typography>
                </Stack>
                <Chip
                  label={`Versão v${task.documentVersionNumber}`}
                  color="primary"
                  size="small"
                />
              </Stack>
              <Divider sx={{ mb: 2 }} />

              {versionsQuery.isLoading ? (
                <Typography variant="body2" color="text.secondary">
                  Carregando dados da versão vinculada...
                </Typography>
              ) : versionsQuery.isError ? (
                <ErrorState
                  title="Falha ao carregar versão vinculada"
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
                    <Alert severity="info">
                      Esta versão não possui arquivo binário associado disponível para exibição.
                    </Alert>
                  )}

                  <Grid container spacing={1.5}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Autor da versão
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {exactBoundVersion.uploadedByUser.fullName}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Registrada em
                      </Typography>
                      <Typography variant="body2">
                        {formatDateTimePtBr(exactBoundVersion.createdAt)}
                      </Typography>
                    </Grid>
                    {exactBoundVersion.fileObject ? (
                      <>
                        <Grid size={{ xs: 12, sm: 6 }}>
                          <Typography variant="caption" color="text.secondary">
                            Tipo MIME detectado
                          </Typography>
                          <Typography variant="body2">
                            {exactBoundVersion.fileObject.detectedContentType}
                          </Typography>
                        </Grid>
                        <Grid size={{ xs: 12, sm: 6 }}>
                          <Typography variant="caption" color="text.secondary">
                            Tamanho do arquivo
                          </Typography>
                          <Typography variant="body2">
                            {formatFileSizePtBr(exactBoundVersion.fileObject.sizeBytes)}
                          </Typography>
                        </Grid>
                        <Grid size={{ xs: 12 }}>
                          <Typography variant="caption" color="text.secondary">
                            Checksum SHA-256
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
                        Nota da versão
                      </Typography>
                      <Typography variant="body2">
                        {exactBoundVersion.changeNote ?? "Nenhuma observação informada."}
                      </Typography>
                    </Grid>
                  </Grid>
                </Stack>
              ) : (
                <Alert severity="warning">
                  A versão vinculada a esta tarefa ({task.documentVersionId}) não foi localizada no
                  histórico autorizado.
                </Alert>
              )}
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                  Metadados do documento
                </Typography>
                <Chip label={documentBadge.label} color={documentBadge.color} size="small" />
              </Stack>
              <Divider sx={{ mb: 2 }} />

              {documentQuery.isLoading ? (
                <Typography variant="body2" color="text.secondary">
                  Carregando metadados do documento...
                </Typography>
              ) : documentQuery.isError ? (
                <Alert severity="warning" role="alert">
                  Não foi possível carregar os metadados completos: {documentQuery.error.message}
                </Alert>
              ) : doc ? (
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Categoria
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.category.name}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Pasta
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.folder ? doc.folder.name : "Sem pasta (raiz)"}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Responsável
                      </Typography>
                      <Typography variant="body2" fontWeight={500}>
                        {doc.owner.fullName}
                      </Typography>
                    </Grid>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        Emissão e vencimento
                      </Typography>
                      <Typography variant="body2">
                        Emissão: {formatIsoDatePtBr(doc.issueDate)} · Vencimento:{" "}
                        {formatIsoDatePtBr(doc.expirationDate)}
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
                      Nenhum metadado personalizado preenchido para este documento.
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
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                Decisão de revisão e aprovação
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {confirmedDecision ? (
                <Alert severity="success" sx={{ mb: 2 }}>
                  {confirmedDecision.decision
                    ? DECISION_LABEL[confirmedDecision.decision.decision]
                    : "Decisão confirmada pela API"}
                  {confirmedDecision.idempotentReplay ? " (confirmação idempotente)" : ""}.
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
                    label="Comentário da revisão"
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
                        ? "Comentário obrigatório para aprovar, rejeitar ou solicitar ajustes."
                        : "Comentário obrigatório ao rejeitar ou solicitar ajustes (opcional ao aprovar).")
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
                        ? "Enviando aprovação..."
                        : "Aprovar"}
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
                        ? "Enviando solicitação..."
                        : "Solicitar ajustes"}
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
                        ? "Enviando rejeição..."
                        : "Rejeitar"}
                    </Button>
                  </Stack>
                </Stack>
              ) : (
                <Alert severity="info">
                  Esta tarefa já foi concluída com o status <strong>{taskBadge.label}</strong>
                  {task.decidedAt ? ` em ${formatDateTimePtBr(task.decidedAt)}` : ""}. Nenhuma nova
                  decisão pode ser enviada.
                </Alert>
              )}
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Stack direction="row" spacing={1} alignItems="center" mb={1}>
                <HistoryOutlinedIcon color="action" fontSize="small" />
                <Typography variant="h6" component="h2">
                  Histórico da tarefa e versões
                </Typography>
              </Stack>
              <Divider sx={{ mb: 1.5 }} />

              <List dense disablePadding>
                <ListItem divider disableGutters>
                  <ListItemText
                    primary={`Tarefa atribuída (${task.stepName})`}
                    secondary={`Criada em ${formatDateTimePtBr(task.createdAt)}${
                      task.dueAt ? ` · Prazo: ${formatDateTimePtBr(task.dueAt)}` : ""
                    }`}
                  />
                </ListItem>

                {task.decidedAt ? (
                  <ListItem divider disableGutters>
                    <ListItemText
                      primary={`Estado final: ${taskBadge.label}`}
                      secondary={`Confirmado em ${formatDateTimePtBr(task.decidedAt)}${
                        confirmedDecision?.decision?.comment
                          ? ` · Comentário: "${confirmedDecision.decision.comment}"`
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
                              Versão v{version.versionNumber}
                            </Typography>
                            {isBoundVersion ? (
                              <Chip label="Avaliada nesta tarefa" color="primary" size="small" />
                            ) : null}
                          </Stack>
                        }
                        secondary={`${version.uploadedByUser.fullName} · ${formatDateTimePtBr(
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
