import type { DocumentListItem, DocumentStatus, FolderRecord } from "@docuflow/contracts";
import {
  DOCUFLOW_COLOR_TOKENS,
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@docuflow/ui";
import ArchiveOutlinedIcon from "@mui/icons-material/ArchiveOutlined";
import ArrowBackOutlinedIcon from "@mui/icons-material/ArrowBackOutlined";
import CreateNewFolderOutlinedIcon from "@mui/icons-material/CreateNewFolderOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { FolderBreadcrumbs } from "./FolderBreadcrumbs.js";
import {
  FolderNavigationError,
  type FolderStatusFilter,
  useArchiveFolderMutation,
  useCreateFolderMutation,
  useFolderNavigationQuery,
  useRenameFolderMutation,
} from "./useFolderNavigation.js";

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

function formatDateTimePtBr(isoDateTime: string): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) {
    return isoDateTime;
  }
  return date.toLocaleString("pt-BR");
}

/**
 * Authorized folder browser page displaying server-validated hierarchical
 * breadcrumbs, child folders, folder documents, and removed/archived handling.
 */
export function FoldersPage() {
  const { folderId: rawFolderId } = useParams();
  const currentFolderId = rawFolderId && rawFolderId.trim().length > 0 ? rawFolderId : null;
  const navigate = useNavigate();

  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [docPage, setDocPage] = useState(1);
  const [docPageSize, setDocPageSize] = useState(20);

  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const statusFilter: FolderStatusFilter = showArchived ? "ALL" : "ACTIVE";
  const navigationQuery = useFolderNavigationQuery(currentFolderId, {
    statusFilter,
    search,
    docPage,
    docPageSize,
  });

  const createFolderMutation = useCreateFolderMutation();
  const renameFolderMutation = useRenameFolderMutation();
  const archiveFolderMutation = useArchiveFolderMutation();

  const navigateToFolder = (targetFolderId: string | null): void => {
    setActionError(null);
    setActionSuccess(null);
    setDocPage(1);
    if (targetFolderId === null) {
      void navigate("/folders");
      return;
    }
    void navigate(`/folders/${targetFolderId}`);
  };

  if (navigationQuery.isLoading) {
    return <LoadingState message="Verificando autorização e carregando pasta..." />;
  }

  if (navigationQuery.isError) {
    const err = navigationQuery.error;
    if (err instanceof FolderNavigationError && err.kind === "FORBIDDEN") {
      return (
        <Stack spacing={2}>
          <Typography variant="h1">Pastas</Typography>
          <Alert severity="warning" role="alert">
            Acesso negado: {err.message}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => navigateToFolder(null)}
            >
              Voltar para a raiz
            </Button>
          </Box>
        </Stack>
      );
    }

    if (err instanceof FolderNavigationError && err.kind === "NOT_FOUND") {
      return (
        <Stack spacing={2}>
          <Typography variant="h1">Pastas</Typography>
          <EmptyState
            title="Pasta removida ou não encontrada"
            description="A pasta solicitada foi removida, não existe nesta organização ou possui endereço inválido."
            actionLabel="Voltar para a raiz"
            onAction={() => navigateToFolder(null)}
          />
        </Stack>
      );
    }

    return (
      <Stack spacing={2}>
        <Typography variant="h1">Pastas</Typography>
        <ErrorState description={err.message} onRetry={() => void navigationQuery.refetch()} />
      </Stack>
    );
  }

  const data = navigationQuery.data;
  if (!data) {
    return null;
  }

  const { currentFolder, breadcrumbs, subfolders, documents, archivedNotice } = data;
  const isCurrentArchived = currentFolder?.status === "ARCHIVED";

  const handleOpenCreate = () => {
    setActionError(null);
    setActionSuccess(null);
    setCreateName("");
    setCreateOpen(true);
  };

  const handleCreateSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setActionError(null);
    setActionSuccess(null);

    const trimmed = createName.trim();
    if (trimmed.length === 0) {
      setActionError("Informe o nome da nova pasta.");
      return;
    }

    try {
      const created = await createFolderMutation.mutateAsync({
        name: trimmed,
        parentId: currentFolder?.id ?? null,
      });
      setCreateOpen(false);
      setActionSuccess(`Pasta "${created.name}" criada com sucesso.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Erro ao criar pasta.");
    }
  };

  const handleOpenRename = () => {
    if (!currentFolder) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    setRenameValue(currentFolder.name);
    setRenameOpen(true);
  };

  const handleRenameSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentFolder) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);

    const trimmed = renameValue.trim();
    if (trimmed.length === 0) {
      setActionError("Informe o novo nome da pasta.");
      return;
    }

    try {
      const updated = await renameFolderMutation.mutateAsync({
        folderId: currentFolder.id,
        name: trimmed,
      });
      setRenameOpen(false);
      setActionSuccess(`Pasta renomeada para "${updated.name}".`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Erro ao renomear pasta.");
    }
  };

  const handleArchiveCurrent = async () => {
    if (!currentFolder || isCurrentArchived) {
      return;
    }
    setActionError(null);
    setActionSuccess(null);
    try {
      const archived = await archiveFolderMutation.mutateAsync({ folderId: currentFolder.id });
      setActionSuccess(`Pasta "${archived.name}" arquivada.`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Erro ao arquivar pasta.");
    }
  };

  const docColumns: DataTableColumn<DocumentListItem>[] = [
    {
      id: "title",
      label: "Título",
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.title}
        </Typography>
      ),
    },
    {
      id: "status",
      label: "Status",
      render: (row) => {
        const badge = DOCUMENT_STATUS_LABELS[row.status];
        return <Chip label={badge.label} color={badge.color} size="small" />;
      },
    },
    {
      id: "updatedAt",
      label: "Atualizado em",
      render: (row) => formatDateTimePtBr(row.updatedAt),
    },
    {
      id: "actions",
      label: "Ações",
      align: "right",
      render: (row) => (
        <Button
          size="small"
          variant="text"
          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            void navigate(`/documents/${row.id}`);
          }}
        >
          Abrir
        </Button>
      ),
    },
  ];

  const renderFolderRow = (folder: FolderRecord) => (
    <ListItem key={folder.id} divider disablePadding>
      <ListItemButton onClick={() => navigateToFolder(folder.id)}>
        <ListItemIcon>
          {folder.status === "ARCHIVED" ? (
            <FolderOutlinedIcon color="disabled" />
          ) : (
            <FolderOpenOutlinedIcon color="primary" />
          )}
        </ListItemIcon>
        <ListItemText primary={folder.name} secondary={folder.materializedPath} />
        <Chip
          label={folder.status === "ARCHIVED" ? "Arquivada" : "Ativa"}
          size="small"
          variant="outlined"
        />
      </ListItemButton>
    </ListItem>
  );

  return (
    <Stack spacing={2.5}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", md: "center" }}
        spacing={2}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            {currentFolder ? currentFolder.name : "Pastas"}
          </Typography>
          <FolderBreadcrumbs items={breadcrumbs} onNavigate={navigateToFolder} />
        </Box>

        <Stack direction="row" spacing={1} flexWrap="wrap">
          {currentFolder ? (
            <>
              <Button
                variant="outlined"
                size="small"
                startIcon={<EditOutlinedIcon />}
                disabled={isCurrentArchived || renameFolderMutation.isPending}
                onClick={handleOpenRename}
              >
                Renomear
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                startIcon={<ArchiveOutlinedIcon />}
                disabled={isCurrentArchived || archiveFolderMutation.isPending}
                onClick={() => void handleArchiveCurrent()}
              >
                Arquivar pasta
              </Button>
            </>
          ) : null}
          <Button
            variant="contained"
            size="small"
            startIcon={<CreateNewFolderOutlinedIcon />}
            disabled={isCurrentArchived}
            onClick={handleOpenCreate}
          >
            Nova pasta
          </Button>
        </Stack>
      </Stack>

      {archivedNotice ? (
        <Alert
          severity="warning"
          action={
            currentFolder ? (
              <Button
                color="inherit"
                size="small"
                onClick={() => navigateToFolder(currentFolder.parentId)}
              >
                Subir nível
              </Button>
            ) : undefined
          }
        >
          {archivedNotice}
        </Alert>
      ) : null}

      {actionSuccess ? (
        <Alert severity="success" onClose={() => setActionSuccess(null)}>
          {actionSuccess}
        </Alert>
      ) : null}

      {actionError ? (
        <Alert severity="error" role="alert" onClose={() => setActionError(null)}>
          {actionError}
        </Alert>
      ) : null}

      <Paper sx={{ p: 2, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: "stretch", sm: "center" }}
        >
          <TextField
            size="small"
            label="Filtrar subpastas"
            placeholder="Digite o nome da pasta..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            sx={{ minWidth: { sm: 280 } }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
              />
            }
            label="Mostrar pastas arquivadas"
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
        <Typography variant="h3" component="h2" gutterBottom>
          {currentFolder ? "Subpastas" : "Pastas na raiz"}
        </Typography>
        {subfolders.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {currentFolder
              ? "Nenhuma subpasta autorizada neste nível."
              : "Nenhuma pasta raiz autorizada encontrada."}
          </Typography>
        ) : (
          <List dense disablePadding>
            {subfolders.map((folder) => renderFolderRow(folder))}
          </List>
        )}
      </Paper>

      {currentFolder && documents ? (
        <Box>
          <Typography variant="h3" component="h2" gutterBottom>
            Documentos em {currentFolder.name}
          </Typography>
          <DataTable
            ariaLabel={`Documentos em ${currentFolder.name}`}
            columns={docColumns}
            rows={documents.items}
            getRowId={(row) => row.id}
            getRowLabel={(row) => row.title}
            page={docPage}
            pageSize={docPageSize}
            totalItems={documents.pagination.totalItems}
            onPageChange={(nextPage) => setDocPage(nextPage)}
            onPageSizeChange={(nextSize) => {
              setDocPageSize(nextSize);
              setDocPage(1);
            }}
            onRowClick={(row) => void navigate(`/documents/${row.id}`)}
            emptyTitle="Pasta sem documentos"
            emptyDescription="Não há documentos autorizados diretamente nesta pasta."
          />
        </Box>
      ) : null}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleCreateSubmit(event)}>
          <DialogTitle>
            {currentFolder ? `Nova subpasta em ${currentFolder.name}` : "Nova pasta na raiz"}
          </DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              fullWidth
              label="Nome da pasta"
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="contained" disabled={createFolderMutation.isPending}>
              {createFolderMutation.isPending ? "Criando..." : "Criar pasta"}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleRenameSubmit(event)}>
          <DialogTitle>Renomear pasta</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              fullWidth
              label="Novo nome da pasta"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRenameOpen(false)}>Cancelar</Button>
            <Button type="submit" variant="contained" disabled={renameFolderMutation.isPending}>
              {renameFolderMutation.isPending ? "Salvando..." : "Salvar nome"}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
