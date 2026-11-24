import type {
  RestoreTrashedDocumentTargetStatus,
  TrashDocumentListItem,
  TrashDocumentsSortField,
} from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, DataTable, type DataTableColumn, FilterBar } from "@docuflow/ui";
import DeleteSweepOutlinedIcon from "@mui/icons-material/DeleteSweepOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import RestoreFromTrashOutlinedIcon from "@mui/icons-material/RestoreFromTrashOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRestoreTrashedDocumentMutation, useTrashDocumentsQuery } from "./useDocumentDetails.js";

const SERVER_SORTABLE_FIELDS = new Set<string>(["deletedAt", "title", "updatedAt"]);

function formatDateTimePtBr(isoDateTime: string | null): string {
  if (!isoDateTime) {
    return "Não informada";
  }
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

/**
 * Trash bin management page listing authorized logically deleted documents,
 * restore deadline windows, and accessible confirmation dialogs to recover items.
 */
export function TrashDocumentsPage() {
  const navigate = useNavigate();
  const dialogTitleId = useId();
  const dialogDescId = useId();

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<TrashDocumentsSortField>("deletedAt");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  const [selectedDoc, setSelectedDoc] = useState<TrashDocumentListItem | null>(null);
  const [targetStatus, setTargetStatus] = useState<RestoreTrashedDocumentTargetStatus>("DRAFT");
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const trashQuery = useTrashDocumentsQuery({
    search: search.trim().length > 0 ? search.trim() : undefined,
    page,
    pageSize,
    sortBy,
    sortDirection,
  });

  const restoreMutation = useRestoreTrashedDocumentMutation();

  const handleSortChange = (field: string, direction: "asc" | "desc"): void => {
    if (!SERVER_SORTABLE_FIELDS.has(field)) {
      return;
    }
    setSortBy(field as TrashDocumentsSortField);
    setSortDirection(direction);
    setPage(1);
  };

  const openRestoreDialog = (doc: TrashDocumentListItem): void => {
    setSelectedDoc(doc);
    setTargetStatus("DRAFT");
    setReason("");
    setDialogError(null);
  };

  const closeRestoreDialog = (): void => {
    if (restoreMutation.isPending) {
      return;
    }
    setSelectedDoc(null);
    setDialogError(null);
  };

  const handleConfirmRestore = async (): Promise<void> => {
    if (!selectedDoc) {
      return;
    }
    setDialogError(null);
    const trimmedReason = reason.trim();

    try {
      const restored = await restoreMutation.mutateAsync({
        documentId: selectedDoc.id,
        payload: {
          expectedVersion: selectedDoc.version,
          targetStatus,
          ...(trimmedReason.length > 0 ? { reason: trimmedReason } : {}),
        },
      });
      setSelectedDoc(null);
      setReason("");
      setFeedback({
        severity: "success",
        message: `Documento "${restored.title}" restaurado com sucesso como ${
          restored.status === "ARCHIVED" ? "Arquivado" : "Rascunho"
        }, mantendo versões e permissões.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha ao restaurar documento da lixeira.";
      setDialogError(message);
      setFeedback({ severity: "error", message });
    }
  };

  const columns: DataTableColumn<TrashDocumentListItem>[] = [
    {
      id: "title",
      label: "Título",
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.title}
        </Typography>
      ),
    },
    {
      id: "categoryId",
      label: "Categoria",
      sortable: false,
      render: (row) => row.categoryName ?? "Categoria restrita",
    },
    {
      id: "deletedAt",
      label: "Enviado à lixeira em",
      sortable: true,
      render: (row) => formatDateTimePtBr(row.deletedAt),
    },
    {
      id: "restoreDeadlineAt",
      label: "Prazo para restauração",
      sortable: false,
      render: (row) => (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="body2">{formatDateTimePtBr(row.restoreDeadlineAt)}</Typography>
          <Chip
            size="small"
            color={row.canRestore ? "success" : "error"}
            label={row.canRestore ? "Disponível" : "Prazo expirado"}
          />
        </Stack>
      ),
    },
    {
      id: "actions",
      label: "Ações",
      align: "right",
      render: (row) => (
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            variant="text"
            endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              void navigate(`/documents/${row.id}`);
            }}
            aria-label={`Abrir ${row.title}`}
          >
            Detalhes
          </Button>
          <Button
            size="small"
            variant="contained"
            startIcon={<RestoreFromTrashOutlinedIcon fontSize="small" />}
            disabled={!row.canRestore}
            onClick={(event) => {
              event.stopPropagation();
              openRestoreDialog(row);
            }}
            aria-label={`Restaurar ${row.title}`}
          >
            Restaurar
          </Button>
        </Stack>
      ),
    },
  ];

  const rows = trashQuery.data?.items ?? [];
  const totalItems = trashQuery.data?.pagination.totalItems ?? 0;

  return (
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
          direction={{ xs: "column", sm: "row" }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ xs: "flex-start", sm: "center" }}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <DeleteSweepOutlinedIcon color="primary" />
              <Typography variant="h1">Lixeira documental</Typography>
            </Stack>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              Documentos excluídos logicamente permanecem recuperáveis durante o prazo de carência
              configurado, preservando histórico de versões e permissões.
            </Typography>
          </Box>
          <Button variant="outlined" onClick={() => void navigate("/documents")}>
            Voltar aos documentos
          </Button>
        </Stack>
      </Paper>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.message}
        </Alert>
      ) : null}

      <FilterBar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchLabel="Pesquisar na lixeira"
        searchPlaceholder="Título do documento..."
        filters={[]}
        hasActiveFilters={search.trim().length > 0}
        onClearFilters={() => {
          setSearch("");
          setPage(1);
        }}
      />

      <DataTable
        ariaLabel="Tabela da lixeira documental"
        columns={columns}
        rows={rows}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        page={page}
        pageSize={pageSize}
        totalItems={totalItems}
        onPageChange={setPage}
        onPageSizeChange={(nextPageSize) => {
          setPageSize(nextPageSize);
          setPage(1);
        }}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        onRowClick={(row) => void navigate(`/documents/${row.id}`)}
        loading={trashQuery.isLoading}
        errorMessage={trashQuery.isError ? trashQuery.error.message : null}
        onRetry={() => void trashQuery.refetch()}
        emptyTitle="Nenhum documento na lixeira"
        emptyDescription="Não há documentos autorizados aguardando restauração na lixeira."
      />

      <Dialog
        open={selectedDoc !== null}
        onClose={closeRestoreDialog}
        aria-labelledby={dialogTitleId}
        aria-describedby={dialogDescId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={dialogTitleId}>Restaurar documento</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            <DialogContentText id={dialogDescId}>
              Ao restaurar "{selectedDoc?.title ?? ""}", todas as versões imutáveis, trilha de
              auditoria e permissões de acesso configuradas serão preservadas.
            </DialogContentText>

            {dialogError ? (
              <Alert severity="error" role="alert">
                {dialogError}
              </Alert>
            ) : null}

            <TextField
              select
              label="Status após restauração"
              value={targetStatus}
              onChange={(event) =>
                setTargetStatus(event.target.value as RestoreTrashedDocumentTargetStatus)
              }
              fullWidth
              disabled={restoreMutation.isPending}
            >
              <MenuItem value="DRAFT">Rascunho</MenuItem>
              <MenuItem value="ARCHIVED">Arquivado</MenuItem>
            </TextField>

            <TextField
              label="Motivo da restauração (opcional)"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
              disabled={restoreMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeRestoreDialog} disabled={restoreMutation.isPending} variant="text">
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirmRestore()}
            disabled={restoreMutation.isPending}
            variant="contained"
          >
            {restoreMutation.isPending ? "Restaurando..." : "Confirmar restauração"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
