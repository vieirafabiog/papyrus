import type { UserStatus, UserSummary } from "@docuflow/contracts";
import {
  ConfirmDialog,
  DOCUFLOW_COLOR_TOKENS,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
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
import {
  canManageGroups,
  canManageUsers,
  useAdminUsersQuery,
  useCreateAdminUserMutation,
  useToggleAdminUserStatusMutation,
  useUpdateAdminUserMutation,
} from "./useUsersAndGroups.js";

const USER_STATUS_BADGE: Readonly<
  Record<UserStatus, { readonly label: string; readonly color: "success" | "default" | "error" }>
> = {
  ACTIVE: { label: "Ativo", color: "success" },
  INACTIVE: { label: "Inativo", color: "default" },
  LOCKED: { label: "Bloqueado", color: "error" },
};

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

/**
 * Administrative user directory view supporting filtering, creation,
 * editing, and activation/deactivation governed by server permissions.
 */
export function UsersPage() {
  const navigate = useNavigate();
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
      const cmp = valA.localeCompare(valB, "pt-BR");
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [usersQuery.data, search, statusFilter, sortBy, sortDirection]);

  const pagedUsers = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredUsers.slice(start, start + pageSize);
  }, [filteredUsers, page, pageSize]);

  if (sessionQuery.isLoading) {
    return <LoadingState message="Verificando permissões de administração..." />;
  }

  if (sessionQuery.data && !hasUserAdminAccess) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para administrar contas de usuário nesta organização."
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
      setCreateError("O nome completo deve ter pelo menos 2 caracteres.");
      return;
    }
    if (!trimmedEmail.includes("@")) {
      setCreateError("Informe um endereço de e-mail válido.");
      return;
    }
    if (newPassword.length < 10) {
      setCreateError("A senha inicial deve possuir no mínimo 10 caracteres.");
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
        message: `Usuário "${created.fullName}" criado com sucesso.`,
      });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Não foi possível criar o usuário.");
    }
  };

  const handleUpdateUser = async (): Promise<void> => {
    if (!editingUser) {
      return;
    }
    setEditError(null);
    const trimmedName = editFullName.trim();
    if (trimmedName.length < 2) {
      setEditError("O nome completo deve ter pelo menos 2 caracteres.");
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
        message: `Dados de "${updated.fullName}" atualizados com sucesso.`,
      });
    } catch (error) {
      setEditError(
        error instanceof Error ? error.message : "Não foi possível atualizar o usuário.",
      );
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
            ? `Usuário "${updated.fullName}" desativado com sucesso.`
            : `Usuário "${updated.fullName}" reativado com sucesso.`,
      });
    } catch (error) {
      setStatusTarget(null);
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : "Não foi possível alterar o status do usuário.",
      });
    }
  };

  const columns: DataTableColumn<UserSummary>[] = [
    {
      id: "fullName",
      label: "Nome",
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.fullName}
        </Typography>
      ),
    },
    {
      id: "email",
      label: "E-mail",
      sortable: true,
      render: (row) => row.email,
    },
    {
      id: "status",
      label: "Status",
      sortable: true,
      render: (row) => {
        const badge = USER_STATUS_BADGE[row.status];
        return <Chip label={badge.label} color={badge.color} size="small" />;
      },
    },
    {
      id: "updatedAt",
      label: "Atualizado em",
      sortable: true,
      render: (row) => formatDateTimePtBr(row.updatedAt),
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
            startIcon={<EditOutlinedIcon fontSize="small" />}
            onClick={(event) => {
              event.stopPropagation();
              setEditError(null);
              setEditFullName(row.fullName);
              setEditingUser(row);
            }}
            aria-label={`Editar ${row.fullName}`}
          >
            Editar
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
              aria-label={`Desativar ${row.fullName}`}
            >
              Desativar
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
              aria-label={`Reativar ${row.fullName}`}
            >
              Reativar
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
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
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
                <Typography variant="h1">Usuários e grupos</Typography>
              </Stack>
              <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
                Cadastre, edite e gerencie o ciclo de acesso das contas da organização.
              </Typography>
            </Box>
          </Stack>

          <Tabs
            value="users"
            onChange={(_event, nextTab: string) => {
              if (nextTab === "groups") {
                void navigate("/admin/grupos");
              }
            }}
            aria-label="Seções de usuários e grupos"
          >
            <Tab value="users" label="Usuários" />
            {hasGroupAdminAccess || sessionQuery.data === null ? (
              <Tab value="groups" label="Grupos" />
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
        searchLabel="Pesquisar usuário"
        searchPlaceholder="Nome ou e-mail..."
        filters={[
          {
            id: "user-status",
            label: "Status",
            value: statusFilter,
            allOptionLabel: "Todos os status",
            options: [
              { value: "ACTIVE", label: "Ativo" },
              { value: "INACTIVE", label: "Inativo" },
              { value: "LOCKED", label: "Bloqueado" },
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
            Novo usuário
          </Button>
        }
      />

      <DataTable
        ariaLabel="Tabela de usuários da organização"
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
        emptyTitle="Nenhum usuário encontrado"
        emptyDescription="Nenhuma conta corresponde aos filtros atuais."
        emptyActionLabel="Novo usuário"
        onEmptyAction={() => setCreateOpen(true)}
      />

      <Dialog
        open={createOpen}
        onClose={createMutation.isPending ? undefined : () => setCreateOpen(false)}
        aria-labelledby={createTitleId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={createTitleId}>Criar usuário</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {createError ? (
              <Alert severity="error" role="alert">
                {createError}
              </Alert>
            ) : null}
            <TextField
              label="Nome completo"
              value={newFullName}
              onChange={(event) => setNewFullName(event.target.value)}
              fullWidth
              required
              disabled={createMutation.isPending}
            />
            <TextField
              type="email"
              label="E-mail corporativo"
              value={newEmail}
              onChange={(event) => setNewEmail(event.target.value)}
              fullWidth
              required
              disabled={createMutation.isPending}
            />
            <TextField
              type="password"
              label="Senha inicial"
              helperText="Mínimo de 10 caracteres."
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
            Cancelar
          </Button>
          <Button
            onClick={() => void handleCreateUser()}
            disabled={createMutation.isPending}
            variant="contained"
          >
            {createMutation.isPending ? "Criando..." : "Criar usuário"}
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
        <DialogTitle id={editTitleId}>Editar usuário</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {editError ? (
              <Alert severity="error" role="alert">
                {editError}
              </Alert>
            ) : null}
            <TextField label="E-mail" value={editingUser?.email ?? ""} fullWidth disabled />
            <TextField
              label="Nome completo"
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
            Cancelar
          </Button>
          <Button
            onClick={() => void handleUpdateUser()}
            disabled={updateMutation.isPending}
            variant="contained"
          >
            {updateMutation.isPending ? "Salvando..." : "Salvar alterações"}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={statusTarget !== null}
        title={statusTarget?.action === "deactivate" ? "Desativar usuário" : "Reativar usuário"}
        description={
          statusTarget?.action === "deactivate"
            ? `Ao desativar "${statusTarget?.user.fullName ?? ""}", as sessões ativas serão revogadas e o acesso ficará suspenso.`
            : `O usuário "${statusTarget?.user.fullName ?? ""}" voltará a ter status ativo para autenticação.`
        }
        confirmLabel={statusTarget?.action === "deactivate" ? "Desativar conta" : "Reativar conta"}
        confirmColor={statusTarget?.action === "deactivate" ? "warning" : "primary"}
        loading={toggleStatusMutation.isPending}
        onConfirm={() => void handleConfirmToggleStatus()}
        onCancel={() => setStatusTarget(null)}
      />
    </Stack>
  );
}
