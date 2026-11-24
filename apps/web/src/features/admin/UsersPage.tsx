import type { UserStatus, UserSummary } from "@docuflow/contracts";
import {
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
} from "@docuflow/ui";
import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import GroupOutlinedIcon from "@mui/icons-material/GroupOutlined";
import PersonAddOutlinedIcon from "@mui/icons-material/PersonAddOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSessionQuery } from "../../app/session.js";
import { useI18n } from "../../i18n/index.js";
import {
  canManageGroups,
  canManageUsers,
  useAdminUsersQuery,
  useCreateAdminUserMutation,
  useToggleAdminUserStatusMutation,
  useUpdateAdminUserMutation,
} from "./useUsersAndGroups.js";

const USER_STATUS_COLORS: Readonly<Record<UserStatus, "success" | "default" | "error">> = {
  ACTIVE: "success",
  INACTIVE: "default",
  LOCKED: "error",
};

/**
 * Administrative user directory view supporting filtering, creation,
 * editing, and activation/deactivation governed by server permissions.
 */
export function UsersPage() {
  const navigate = useNavigate();
  const { locale, t, formatDateTime } = useI18n();
  const createTitleId = useId();
  const editTitleId = useId();

  const sessionQuery = useSessionQuery();
  const hasUserAdminAccess =
    sessionQuery.data === undefined ? true : canManageUsers(sessionQuery.data);
  const hasGroupAdminAccess = canManageGroups(sessionQuery.data);

  const usersQuery = useAdminUsersQuery(
    !sessionQuery.isLoading && (sessionQuery.data === null || hasUserAdminAccess),
  );
  const createMutation = useCreateAdminUserMutation();
  const updateMutation = useUpdateAdminUserMutation();
  const toggleStatusMutation = useToggleAdminUserStatusMutation();

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<UserStatus | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<"fullName" | "email" | "status" | "updatedAt">("fullName");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const [createOpen, setCreateOpen] = useState(false);
  const [newFullName, setNewFullName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [editingUser, setEditingUser] = useState<UserSummary | null>(null);
  const [editFullName, setEditFullName] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const [statusTarget, setStatusTarget] = useState<{
    readonly user: UserSummary;
    readonly action: "deactivate" | "reactivate";
  } | null>(null);

  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const filteredUsers = useMemo(() => {
    const allUsers = usersQuery.data ?? [];
    const term = search.trim().toLowerCase();
    const filtered = allUsers.filter((user) => {
      if (statusFilter.length > 0 && user.status !== statusFilter) {
        return false;
      }
      if (term.length > 0) {
        return (
          user.fullName.toLowerCase().includes(term) || user.email.toLowerCase().includes(term)
        );
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      const valA = a[sortBy];
      const valB = b[sortBy];
      const cmp = valA.localeCompare(valB, locale);
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [usersQuery.data, search, statusFilter, sortBy, sortDirection, locale]);

  const pagedUsers = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredUsers.slice(start, start + pageSize);
  }, [filteredUsers, page, pageSize]);

  if (sessionQuery.isLoading) {
    return <LoadingState message={t("admin.common.checkingPermissions")} />;
  }

  if (sessionQuery.data && !hasUserAdminAccess) {
    return (
      <ErrorState
        title={t("admin.common.restrictedAccessTitle")}
        description={t("admin.users.noAccessDescription")}
      />
    );
  }

  const handleSortChange = (field: string, direction: "asc" | "desc"): void => {
    if (field === "fullName" || field === "email" || field === "status" || field === "updatedAt") {
      setSortBy(field);
      setSortDirection(direction);
      setPage(1);
    }
  };

  const handleCreateUser = async (): Promise<void> => {
    setCreateError(null);
    const trimmedName = newFullName.trim();
    const trimmedEmail = newEmail.trim().toLowerCase();

    if (trimmedName.length < 2) {
      setCreateError(t("admin.users.validation.nameTooShort"));
      return;
    }
    if (!trimmedEmail.includes("@")) {
      setCreateError(t("admin.users.validation.invalidEmail"));
      return;
    }
    if (newPassword.length < 10) {
      setCreateError(t("admin.users.validation.passwordTooShort"));
      return;
    }

    try {
      const created = await createMutation.mutateAsync({
        fullName: trimmedName,
        email: trimmedEmail,
        password: newPassword,
      });
      setCreateOpen(false);
      setNewFullName("");
      setNewEmail("");
      setNewPassword("");
      setFeedback({
        severity: "success",
        message: t("admin.users.feedback.created", { name: created.fullName }),
      });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("admin.users.errors.createFailed"));
    }
  };

  const handleUpdateUser = async (): Promise<void> => {
    if (!editingUser) {
      return;
    }
    setEditError(null);
    const trimmedName = editFullName.trim();
    if (trimmedName.length < 2) {
      setEditError(t("admin.users.validation.nameTooShort"));
      return;
    }

    try {
      const updated = await updateMutation.mutateAsync({
        userId: editingUser.id,
        payload: { fullName: trimmedName },
      });
      setEditingUser(null);
      setFeedback({
        severity: "success",
        message: t("admin.users.feedback.updated", { name: updated.fullName }),
      });
    } catch (error) {
      setEditError(error instanceof Error ? error.message : t("admin.users.errors.updateFailed"));
    }
  };

  const handleConfirmToggleStatus = async (): Promise<void> => {
    if (!statusTarget) {
      return;
    }
    try {
      const updated = await toggleStatusMutation.mutateAsync({
        userId: statusTarget.user.id,
        action: statusTarget.action,
      });
      setStatusTarget(null);
      setFeedback({
        severity: "success",
        message:
          updated.status === "INACTIVE"
            ? t("admin.users.feedback.deactivated", { name: updated.fullName })
            : t("admin.users.feedback.reactivated", { name: updated.fullName }),
      });
    } catch (error) {
      setStatusTarget(null);
      setFeedback({
        severity: "error",
        message: error instanceof Error ? error.message : t("admin.users.errors.toggleFailed"),
      });
    }
  };

  const getStatusLabel = (status: UserStatus): string => {
    switch (status) {
      case "ACTIVE":
        return t("admin.users.status.ACTIVE");
      case "INACTIVE":
        return t("admin.users.status.INACTIVE");
      case "LOCKED":
        return t("admin.users.status.LOCKED");
    }
  };

  const columns: DataTableColumn<UserSummary>[] = [
    {
      id: "fullName",
      label: t("admin.users.table.name"),
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.fullName}
        </Typography>
      ),
    },
    {
      id: "email",
      label: t("admin.users.table.email"),
      sortable: true,
      render: (row) => row.email,
    },
    {
      id: "status",
      label: t("admin.common.status"),
      sortable: true,
      render: (row) => (
        <Chip
          label={getStatusLabel(row.status)}
          color={USER_STATUS_COLORS[row.status]}
          size="small"
        />
      ),
    },
    {
      id: "updatedAt",
      label: t("admin.common.updatedAt"),
      sortable: true,
      render: (row) => formatDateTime(row.updatedAt),
    },
    {
      id: "actions",
      label: t("admin.common.actions"),
      align: "right",
      render: (row) => (
        <Stack direction="row" spacing={1} justifyContent="flex-end">
          <Button
            size="small"
            variant="text"
            startIcon={<EditOutlinedIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              setEditError(null);
              setEditFullName(row.fullName);
              setEditingUser(row);
            }}
            aria-label={t("admin.users.actions.editAria", { name: row.fullName })}
          >
            {t("admin.common.edit")}
          </Button>
          {row.status === "ACTIVE" ? (
            <Button
              size="small"
              variant="text"
              color="warning"
              startIcon={<BlockOutlinedIcon fontSize="small" />}
              onClick={(event) => {
                event.stopPropagation();
                setStatusTarget({ user: row, action: "deactivate" });
              }}
              aria-label={t("admin.users.actions.deactivateAria", { name: row.fullName })}
            >
              {t("admin.common.deactivate")}
            </Button>
          ) : (
            <Button
              size="small"
              variant="text"
              color="success"
              startIcon={<CheckCircleOutlineOutlinedIcon fontSize="small" />}
              onClick={(event) => {
                event.stopPropagation();
                setStatusTarget({ user: row, action: "reactivate" });
              }}
              aria-label={t("admin.users.actions.reactivateAria", { name: row.fullName })}
            >
              {t("admin.common.reactivate")}
            </Button>
          )}
        </Stack>
      ),
    },
  ];

  return (
    <Stack spacing={2.5}>
      <Paper
        variant="outlined"
        sx={{
          p: 2.5,
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack spacing={1.5}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={1.5}
            justifyContent="space-between"
            alignItems={{ xs: "flex-start", sm: "center" }}
          >
            <Box>
              <Stack direction="row" spacing={1} alignItems="center">
                <GroupOutlinedIcon color="primary" />
                <Typography variant="h1">{t("admin.usersAndGroups.title")}</Typography>
              </Stack>
              <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
                {t("admin.users.subtitle")}
              </Typography>
            </Box>
          </Stack>

          <Tabs
            value="users"
            onChange={(_event, nextTab: string) => {
              if (nextTab === "groups") {
                void navigate("/admin/groups");
              }
            }}
            aria-label={t("admin.usersAndGroups.tabsAriaLabel")}
          >
            <Tab value="users" label={t("admin.usersAndGroups.usersTab")} />
            {hasGroupAdminAccess || sessionQuery.data === null ? (
              <Tab value="groups" label={t("admin.usersAndGroups.groupsTab")} />
            ) : null}
          </Tabs>
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
        searchLabel={t("admin.users.filters.searchLabel")}
        searchPlaceholder={t("admin.users.filters.searchPlaceholder")}
        filters={[
          {
            id: "user-status",
            label: t("admin.users.filters.statusLabel"),
            value: statusFilter,
            allOptionLabel: t("admin.users.filters.allStatuses"),
            options: [
              { value: "ACTIVE", label: t("admin.users.status.ACTIVE") },
              { value: "INACTIVE", label: t("admin.users.status.INACTIVE") },
              { value: "LOCKED", label: t("admin.users.status.LOCKED") },
            ],
            onChange: (value) => {
              setStatusFilter(value as UserStatus | "");
              setPage(1);
            },
          },
        ]}
        hasActiveFilters={search.trim().length > 0 || statusFilter.length > 0}
        onClearFilters={() => {
          setSearch("");
          setStatusFilter("");
          setPage(1);
        }}
        actions={
          <Button
            variant="contained"
            startIcon={<PersonAddOutlinedIcon />}
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            {t("admin.users.actions.newUser")}
          </Button>
        }
      />

      <DataTable
        ariaLabel={t("admin.users.table.ariaLabel")}
        columns={columns}
        rows={pagedUsers}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.fullName}
        page={page}
        pageSize={pageSize}
        totalItems={filteredUsers.length}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        loading={usersQuery.isLoading}
        errorMessage={usersQuery.isError ? usersQuery.error.message : null}
        onRetry={() => void usersQuery.refetch()}
        emptyTitle={t("admin.users.table.emptyTitle")}
        emptyDescription={t("admin.users.table.emptyDescription")}
        emptyActionLabel={t("admin.users.actions.newUser")}
        onEmptyAction={() => setCreateOpen(true)}
      />

      <Dialog
        open={createOpen}
        onClose={createMutation.isPending ? undefined : () => setCreateOpen(false)}
        aria-labelledby={createTitleId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={createTitleId}>{t("admin.users.createDialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {createError ? (
              <Alert severity="error" role="alert">
                {createError}
              </Alert>
            ) : null}
            <TextField
              label={t("admin.users.createDialog.fullName")}
              value={newFullName}
              onChange={(event) => setNewFullName(event.target.value)}
              fullWidth
              required
              disabled={createMutation.isPending}
            />
            <TextField
              type="email"
              label={t("admin.users.createDialog.email")}
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              fullWidth
              required
              disabled={createMutation.isPending}
            />
            <TextField
              type="password"
              label={t("admin.users.createDialog.initialPassword")}
              helperText={t("admin.users.createDialog.passwordHelper")}
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              fullWidth
              required
              disabled={createMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setCreateOpen(false)}
            disabled={createMutation.isPending}
            variant="text"
          >
            {t("admin.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleCreateUser()}
            disabled={createMutation.isPending}
            variant="contained"
          >
            {createMutation.isPending
              ? t("admin.common.creating")
              : t("admin.users.createDialog.submit")}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={editingUser !== null}
        onClose={updateMutation.isPending ? undefined : () => setEditingUser(null)}
        aria-labelledby={editTitleId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={editTitleId}>{t("admin.users.editDialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {editError ? (
              <Alert severity="error" role="alert">
                {editError}
              </Alert>
            ) : null}
            <TextField
              label={t("admin.users.editDialog.email")}
              value={editingUser?.email ?? ""}
              fullWidth
              disabled
            />
            <TextField
              label={t("admin.users.editDialog.fullName")}
              value={editFullName}
              onChange={(event) => setEditFullName(event.target.value)}
              fullWidth
              required
              disabled={updateMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setEditingUser(null)}
            disabled={updateMutation.isPending}
            variant="text"
          >
            {t("admin.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleUpdateUser()}
            disabled={updateMutation.isPending}
            variant="contained"
          >
            {updateMutation.isPending ? t("admin.common.saving") : t("admin.common.saveChanges")}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={statusTarget !== null}
        title={
          statusTarget?.action === "deactivate"
            ? t("admin.users.confirmToggle.deactivateTitle")
            : t("admin.users.confirmToggle.reactivateTitle")
        }
        description={
          statusTarget?.action === "deactivate"
            ? t("admin.users.confirmToggle.deactivateDescription", {
                name: statusTarget?.user.fullName ?? "",
              })
            : t("admin.users.confirmToggle.reactivateDescription", {
                name: statusTarget?.user.fullName ?? "",
              })
        }
        confirmLabel={
          statusTarget?.action === "deactivate"
            ? t("admin.users.confirmToggle.deactivateConfirm")
            : t("admin.users.confirmToggle.reactivateConfirm")
        }
        confirmColor={statusTarget?.action === "deactivate" ? "warning" : "primary"}
        loading={toggleStatusMutation.isPending}
        onConfirm={() => void handleConfirmToggleStatus()}
        onCancel={() => setStatusTarget(null)}
      />
    </Stack>
  );
}
