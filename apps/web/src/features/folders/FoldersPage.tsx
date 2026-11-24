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
import type { DocumentListItem, DocumentStatus, FolderRecord } from "@papyrus/contracts";
import {
  DataTable,
  type DataTableColumn,
  EmptyState,
  ErrorState,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
} from "@papyrus/ui";
import { type FormEvent, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { containsTechnicalJargon } from "../../i18n/api-errors.js";
import { useI18n } from "../../i18n/index.js";
import { FolderBreadcrumbs } from "./FolderBreadcrumbs.js";
import {
  FolderNavigationError,
  type FolderStatusFilter,
  useArchiveFolderMutation,
  useCreateFolderMutation,
  useFolderNavigationQuery,
  useRenameFolderMutation,
} from "./useFolderNavigation.js";

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

/**
 * Authorized folder browser page displaying server-validated hierarchical
 * breadcrumbs, child folders, folder documents, and removed/archived handling.
 */
export function FoldersPage() {
  const { t, formatDateTime } = useI18n();
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
    return <LoadingState message={t("folders.loading")} />;
  }

  if (navigationQuery.isError) {
    const err = navigationQuery.error;
    if (err instanceof FolderNavigationError && err.kind === "FORBIDDEN") {
      return (
        <Stack spacing={2}>
          <Typography variant="h1">{t("folders.pageTitle")}</Typography>
          <Alert severity="warning" role="alert">
            {t("folders.accessDeniedPrefix", { message: err.message })}
          </Alert>
          <Box>
            <Button
              variant="outlined"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => navigateToFolder(null)}
            >
              {t("folders.backToRoot")}
            </Button>
          </Box>
        </Stack>
      );
    }

    if (err instanceof FolderNavigationError && err.kind === "NOT_FOUND") {
      return (
        <Stack spacing={2}>
          <Typography variant="h1">{t("folders.pageTitle")}</Typography>
          <EmptyState
            title={t("folders.notFoundTitle")}
            description={t("folders.notFoundDescription")}
            actionLabel={t("folders.backToRoot")}
            onAction={() => navigateToFolder(null)}
          />
        </Stack>
      );
    }

    return (
      <Stack spacing={2}>
        <Typography variant="h1">{t("folders.pageTitle")}</Typography>
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
      setActionError(t("folders.validation.nameRequired"));
      return;
    }

    try {
      const created = await createFolderMutation.mutateAsync({
        name: trimmed,
        parentId: currentFolder?.id ?? null,
      });
      setCreateOpen(false);
      setActionSuccess(t("folders.feedback.created", { name: created.name }));
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setActionError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("folders.feedback.createError"),
      );
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
      setActionError(t("folders.validation.renameRequired"));
      return;
    }

    try {
      const updated = await renameFolderMutation.mutateAsync({
        folderId: currentFolder.id,
        name: trimmed,
      });
      setRenameOpen(false);
      setActionSuccess(t("folders.feedback.renamed", { name: updated.name }));
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setActionError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("folders.feedback.renameError"),
      );
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
      setActionSuccess(t("folders.feedback.archived", { name: archived.name }));
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message.trim() : "";
      setActionError(
        rawMessage.length > 0 && !containsTechnicalJargon(rawMessage)
          ? rawMessage
          : t("folders.feedback.archiveError"),
      );
    }
  };

  const docColumns: DataTableColumn<DocumentListItem>[] = [
    {
      id: "title",
      label: t("folders.columns.title"),
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.title}
        </Typography>
      ),
    },
    {
      id: "status",
      label: t("folders.columns.status"),
      render: (row) => (
        <Chip
          label={t(`documents.status.${row.status}`)}
          color={DOCUMENT_STATUS_COLOR[row.status]}
          size="small"
        />
      ),
    },
    {
      id: "updatedAt",
      label: t("folders.columns.updatedAt"),
      render: (row) => formatDateTime(row.updatedAt),
    },
    {
      id: "actions",
      label: t("folders.columns.actions"),
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
          {t("documents.common.open")}
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
          label={
            folder.status === "ARCHIVED" ? t("folders.status.archived") : t("folders.status.active")
          }
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
            {currentFolder ? currentFolder.name : t("folders.pageTitle")}
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
                {t("folders.renameButton")}
              </Button>
              <Button
                variant="outlined"
                color="warning"
                size="small"
                startIcon={<ArchiveOutlinedIcon />}
                disabled={isCurrentArchived || archiveFolderMutation.isPending}
                onClick={() => void handleArchiveCurrent()}
              >
                {t("folders.archiveButton")}
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
            {t("folders.newFolderButton")}
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
                {t("folders.goUpButton")}
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

      <Paper sx={{ p: 2, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          justifyContent="space-between"
          alignItems={{ xs: "stretch", sm: "center" }}
        >
          <TextField
            size="small"
            label={t("folders.filterSubfoldersLabel")}
            placeholder={t("folders.filterSubfoldersPlaceholder")}
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
            label={t("folders.showArchivedSwitch")}
          />
        </Stack>
      </Paper>

      <Paper sx={{ p: 2.5, bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
        <Typography variant="h3" component="h2" gutterBottom>
          {currentFolder ? t("folders.subfoldersHeading") : t("folders.rootFoldersHeading")}
        </Typography>
        {subfolders.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {currentFolder ? t("folders.noSubfolders") : t("folders.noRootFolders")}
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
            {t("folders.documentsInHeading", { name: currentFolder.name })}
          </Typography>
          <DataTable
            ariaLabel={t("folders.documentsTableAria", { name: currentFolder.name })}
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
            emptyTitle={t("folders.emptyDocumentsTitle")}
            emptyDescription={t("folders.emptyDocumentsDescription")}
          />
        </Box>
      ) : null}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleCreateSubmit(event)}>
          <DialogTitle>
            {currentFolder
              ? t("folders.createDialogTitleInFolder", { name: currentFolder.name })
              : t("folders.createDialogTitleRoot")}
          </DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              fullWidth
              label={t("folders.folderNameLabel")}
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setCreateOpen(false)}>{t("documents.common.cancel")}</Button>
            <Button type="submit" variant="contained" disabled={createFolderMutation.isPending}>
              {createFolderMutation.isPending ? t("folders.creating") : t("folders.createSubmit")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} fullWidth maxWidth="xs">
        <form onSubmit={(event) => void handleRenameSubmit(event)}>
          <DialogTitle>{t("folders.renameDialogTitle")}</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              margin="dense"
              fullWidth
              label={t("folders.newFolderNameLabel")}
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setRenameOpen(false)}>{t("documents.common.cancel")}</Button>
            <Button type="submit" variant="contained" disabled={renameFolderMutation.isPending}>
              {renameFolderMutation.isPending ? t("folders.saving") : t("folders.saveName")}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Stack>
  );
}
