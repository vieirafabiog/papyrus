import type { DocumentMetadataValue, DocumentStatus } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import CategoryOutlinedIcon from "@mui/icons-material/CategoryOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import EventOutlinedIcon from "@mui/icons-material/EventOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import PersonOutlineOutlinedIcon from "@mui/icons-material/PersonOutlineOutlined";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import { Alert, Box, Button, Chip, Divider, Grid, Paper, Stack, Typography } from "@mui/material";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { DocumentTagsField } from "../tags/DocumentTagsField.js";
import { DocumentLifecycleActions } from "./DocumentLifecycleActions.js";
import { DocumentMetadataForm } from "./DocumentMetadataForm.js";
import { DocumentPreviewPanel } from "./DocumentPreviewPanel.js";
import { DocumentFileAvailabilityPanel } from "./FileProcessingStatus.js";
import { UploadDialog } from "./UploadDialog.js";
import { VersionHistory } from "./VersionHistory.js";
import {
  documentDetailsQueryKey,
  documentVersionsQueryKey,
  useDocumentDetailsQuery,
} from "./useDocumentDetails.js";

const DOCUMENT_STATUS_LABELS: Readonly<
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

function formatIsoDatePtBr(isoDate: string | null): string {
  if (!isoDate) {
    return "Não informada";
  }
  const [yearRaw, monthRaw, dayRaw] = isoDate.split("-");
  if (!yearRaw || !monthRaw || !dayRaw) {
    return isoDate;
  }
  return `${dayRaw}/${monthRaw}/${yearRaw}`;
}

function formatDateTimePtBr(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) {
    return isoDateTime;
  }
  return date.toLocaleString("pt-BR");
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
 * Document details view displaying taxonomy, owner, dates, typed metadata,
 * file security status, and authorized actions in pt-BR.
 */
export function DocumentDetailsPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [uploadNewVersionOpen, setUploadNewVersionOpen] = useState(false);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [lifecycleFeedback, setLifecycleFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const query = useDocumentDetailsQuery(id);

  if (query.isLoading) {
    return <LoadingState message="Carregando detalhes do documento..." />;
  }

  if (query.isError) {
    if (query.error.statusCode === 403) {
      return (
        <Stack spacing={2}>
          <Alert severity="warning" role="alert">
            Acesso negado: {query.error.message}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => void navigate("/documentos")}
            >
              Voltar para documentos
            </Button>
          </Box>
        </Stack>
      );
    }

    if (query.error.statusCode === 404) {
      return (
        <EmptyState
          title="Documento não encontrado"
          description="O registro solicitado não existe ou não está mais disponível nesta organização."
          actionLabel="Voltar para documentos"
          onAction={() => void navigate("/documentos")}
        />
      );
    }

    return (
      <ErrorState
        title="Não foi possível carregar o documento"
        description={query.error.message}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const doc = query.data;
  if (!doc) {
    return null;
  }

  const statusDescriptor = DOCUMENT_STATUS_LABELS[doc.status];
  const sortedFields = [...doc.category.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const definedKeys = new Set(sortedFields.map((field) => field.key));
  const extraMetadataKeys = Object.keys(doc.metadata).filter((key) => !definedKeys.has(key));

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
            onClick={() => void navigate("/documentos")}
            sx={{ alignSelf: "flex-start" }}
          >
            Voltar para documentos
          </Button>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
            <DescriptionOutlinedIcon color="primary" />
            <Typography variant="h1">{doc.title}</Typography>
            <Chip label={statusDescriptor.label} color={statusDescriptor.color} size="small" />
            {doc.currentVersion ? (
              <Chip
                label={`Versão v${doc.currentVersion.versionNumber}`}
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
              Editar metadados
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
              Enviar nova versão
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
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                Classificação, responsável e datas
              </Typography>
              <Divider sx={{ mb: 2 }} />

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <CategoryOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        Categoria
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
                        Pasta
                      </Typography>
                    </Stack>
                    {doc.folder ? (
                      <Button
                        variant="text"
                        size="small"
                        sx={{ justifyContent: "flex-start", px: 0, textTransform: "none" }}
                        onClick={() => void navigate(`/pastas/${doc.folder?.id}`)}
                      >
                        {doc.folder.name}
                      </Button>
                    ) : (
                      <Typography variant="body1" fontWeight={500}>
                        Sem pasta (raiz)
                      </Typography>
                    )}
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Stack spacing={0.5}>
                    <Stack direction="row" spacing={0.75} alignItems="center">
                      <PersonOutlineOutlinedIcon fontSize="small" color="action" />
                      <Typography variant="caption" color="text.secondary">
                        Responsável
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
                        Vigência
                      </Typography>
                    </Stack>
                    <Typography variant="body2">
                      Emissão: <strong>{formatIsoDatePtBr(doc.issueDate)}</strong>
                    </Typography>
                    <Typography variant="body2">
                      Vencimento: <strong>{formatIsoDatePtBr(doc.expirationDate)}</strong>
                    </Typography>
                  </Stack>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography variant="caption" color="text.secondary">
                    Criado em
                  </Typography>
                  <Typography variant="body2">{formatDateTimePtBr(doc.createdAt)}</Typography>
                </Grid>

                <Grid size={{ xs: 12, sm: 6 }}>
                  <Typography variant="caption" color="text.secondary">
                    Última atualização
                  </Typography>
                  <Typography variant="body2">{formatDateTimePtBr(doc.updatedAt)}</Typography>
                </Grid>
              </Grid>
            </Paper>

            <Paper
              variant="outlined"
              sx={{
                p: 2.5,
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                Metadados personalizados
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
                  Nenhum metadado personalizado configurado para esta categoria.
                </Typography>
              ) : (
                <Grid container spacing={2}>
                  {sortedFields.map((field) => (
                    <Grid key={field.id} size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {field.label}
                      </Typography>
                      <Typography variant="body1">
                        {formatMetadataValue(doc.metadata[field.key])}
                      </Typography>
                    </Grid>
                  ))}
                  {extraMetadataKeys.map((extraKey) => (
                    <Grid key={extraKey} size={{ xs: 12, sm: 6 }}>
                      <Typography variant="caption" color="text.secondary">
                        {extraKey}
                      </Typography>
                      <Typography variant="body1">
                        {formatMetadataValue(doc.metadata[extraKey])}
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
                bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
              }}
            >
              <Typography variant="h6" component="h2" gutterBottom>
                Arquivo vigente
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
                      Tipo detectado:{" "}
                      <strong>{doc.currentVersion.fileObject.detectedContentType}</strong>
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Tamanho:{" "}
                      <strong>{formatFileSizePtBr(doc.currentVersion.fileObject.sizeBytes)}</strong>
                    </Typography>
                  </Stack>
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Nenhuma versão de arquivo vinculada a este documento.
                </Typography>
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
              <DocumentTagsField documentId={doc.id} canEdit={doc.permissions.canUpdate} />
            </Paper>
          </Stack>
        </Grid>

        <Grid size={{ xs: 12 }}>
          <DocumentPreviewPanel document={doc} />
        </Grid>

        <Grid size={{ xs: 12 }}>
          <VersionHistory
            document={doc}
            onUploadNewVersion={
              doc.permissions.canUpload ? () => setUploadNewVersionOpen(true) : undefined
            }
          />
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
    </Stack>
  );
}
