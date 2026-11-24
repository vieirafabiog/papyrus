import type { GroupSummary, UserSummary } from "@docuflow/contracts";
import {
  ConfirmDialog,
  DOCUFLOW_COLOR_TOKENS,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
} from "@docuflow/ui";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import GroupAddOutlinedIcon from "@mui/icons-material/GroupAddOutlined";
import GroupOutlinedIcon from "@mui/icons-material/GroupOutlined";
import GroupsOutlinedIcon from "@mui/icons-material/GroupsOutlined";
import PersonAddAltOutlinedIcon from "@mui/icons-material/PersonAddAltOutlined";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemText,
  MenuItem,
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
  useAddGroupMemberMutation,
  useAdminGroupsQuery,
  useAdminUsersQuery,
  useCreateAdminGroupMutation,
  useGroupMembersQuery,
  useRemoveGroupMemberMutation,
} from "./useUsersAndGroups.js";

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

/**
 * Administrative group directory page supporting group creation, filtering,
 * and associating or disassociating users in groups according to permissions.
 */
export function GroupsPage() {
  const navigate = useNavigate();
  const createTitleId = useId();
  const membersTitleId = useId();

  const sessionQuery = useSessionQuery();
  const hasGroupAdminAccess =
    sessionQuery.data === undefined ? true : canManageGroups(sessionQuery.data);
  const hasUserAdminAccess = canManageUsers(sessionQuery.data);

  const groupsQuery = useAdminGroupsQuery(
    !sessionQuery.isLoading && (sessionQuery.data === null || hasGroupAdminAccess),
  );
  const usersQuery = useAdminUsersQuery(
    !sessionQuery.isLoading && (sessionQuery.data === null || hasUserAdminAccess),
  );

  const createGroupMutation = useCreateAdminGroupMutation();
  const addMemberMutation = useAddGroupMemberMutation();
  const removeMemberMutation = useRemoveGroupMemberMutation();

  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [sortBy, setSortBy] = useState<"name" | "updatedAt">("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const [createOpen, setCreateOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const [selectedGroup, setSelectedGroup] = useState<GroupSummary | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [memberError, setMemberError] = useState<string | null>(null);
  const [memberToRemove, setMemberToRemove] = useState<UserSummary | null>(null);

  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const membersQuery = useGroupMembersQuery(selectedGroup?.id ?? null, selectedGroup !== null);

  const filteredGroups = useMemo(() => {
    const allGroups = groupsQuery.data ?? [];
    const term = search.trim().toLowerCase();
    const filtered = allGroups.filter((group) => {
      if (term.length === 0) {
        return true;
      }
      return (
        group.name.toLowerCase().includes(term) ||
        (group.description ?? "").toLowerCase().includes(term)
      );
    });

    return [...filtered].sort((a, b) => {
      const cmp = a[sortBy].localeCompare(b[sortBy], "pt-BR");
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [groupsQuery.data, search, sortBy, sortDirection]);

  const pagedGroups = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredGroups.slice(start, start + pageSize);
  }, [filteredGroups, page, pageSize]);

  const availableUsersToAdd = useMemo(() => {
    const allUsers = usersQuery.data ?? [];
    const memberIds = new Set((membersQuery.data ?? []).map((member) => member.id));
    return allUsers.filter((user) => user.status === "ACTIVE" && !memberIds.has(user.id));
  }, [usersQuery.data, membersQuery.data]);

  if (sessionQuery.isLoading) {
    return <LoadingState message="Verificando permissões de administração..." />;
  }

  if (sessionQuery.data && !hasGroupAdminAccess) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para administrar grupos nesta organização."
      />
    );
  }

  const handleSortChange = (field: string, direction: "asc" | "desc"): void => {
    if (field === "name" || field === "updatedAt") {
      setSortBy(field);
      setSortDirection(direction);
      setPage(1);
    }
  };

  const handleCreateGroup = async (): Promise<void> => {
    setCreateError(null);
    const trimmedName = groupName.trim();
    const trimmedDesc = groupDescription.trim();

    if (trimmedName.length < 2) {
      setCreateError("O nome do grupo deve ter pelo menos 2 caracteres.");
      return;
    }

    try {
      const created = await createGroupMutation.mutateAsync({
        name: trimmedName,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
      });
      setCreateOpen(false);
      setGroupName("");
      setGroupDescription("");
      setFeedback({
        severity: "success",
        message: `Grupo "${created.name}" criado com sucesso.`,
      });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : "Não foi possível criar o grupo.");
    }
  };

  const handleAssociateMember = async (): Promise<void> => {
    if (!selectedGroup || selectedUserId.trim().length === 0) {
      return;
    }
    setMemberError(null);

    try {
      await addMemberMutation.mutateAsync({
        groupId: selectedGroup.id,
        userId: selectedUserId,
      });
      setSelectedUserId("");
      setFeedback({
        severity: "success",
        message: `Usuário associado ao grupo "${selectedGroup.name}".`,
      });
    } catch (error) {
      setMemberError(
        error instanceof Error ? error.message : "Não foi possível associar o usuário ao grupo.",
      );
    }
  };

  const handleConfirmRemoveMember = async (): Promise<void> => {
    if (!selectedGroup || !memberToRemove) {
      return;
    }
    setMemberError(null);

    try {
      await removeMemberMutation.mutateAsync({
        groupId: selectedGroup.id,
        userId: memberToRemove.id,
      });
      setFeedback({
        severity: "success",
        message: `Usuário "${memberToRemove.fullName}" removido do grupo "${selectedGroup.name}".`,
      });
      setMemberToRemove(null);
    } catch (error) {
      setMemberError(
        error instanceof Error ? error.message : "Não foi possível remover o membro do grupo.",
      );
      setMemberToRemove(null);
    }
  };

  const columns: DataTableColumn<GroupSummary>[] = [
    {
      id: "name",
      label: "Nome do grupo",
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.name}
        </Typography>
      ),
    },
    {
      id: "description",
      label: "Descrição",
      sortable: false,
      render: (row) => row.description ?? "Sem descrição",
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
        <Button
          size="small"
          variant="outlined"
          startIcon={<GroupsOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            setMemberError(null);
            setSelectedUserId("");
            setSelectedGroup(row);
          }}
          aria-label={`Gerenciar membros de ${row.name}`}
        >
          Gerenciar membros
        </Button>
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
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <GroupOutlinedIcon color="primary" />
              <Typography variant="h1">Usuários e grupos</Typography>
            </Stack>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              Organize equipes de trabalho e associe membros para escopos e aprovações.
            </Typography>
          </Box>

          <Tabs
            value="groups"
            onChange={(_event, nextTab: string) => {
              if (nextTab === "users") {
                void navigate("/admin/users");
              }
            }}
            aria-label="Seções de usuários e grupos"
          >
            {hasUserAdminAccess || sessionQuery.data === null ? (
              <Tab value="users" label="Usuários" />
            ) : null}
            <Tab value="groups" label="Grupos" />
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
        searchLabel="Pesquisar grupo"
        searchPlaceholder="Nome ou descrição..."
        filters={[]}
        hasActiveFilters={search.trim().length > 0}
        onClearFilters={() => {
          setSearch("");
          setPage(1);
        }}
        actions={
          <Button
            variant="contained"
            startIcon={<GroupAddOutlinedIcon />}
            onClick={() => {
              setCreateError(null);
              setCreateOpen(true);
            }}
          >
            Novo grupo
          </Button>
        }
      />

      <DataTable
        ariaLabel="Tabela de grupos da organização"
        columns={columns}
        rows={pagedGroups}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.name}
        page={page}
        pageSize={pageSize}
        totalItems={filteredGroups.length}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={handleSortChange}
        onRowClick={(row) => {
          setMemberError(null);
          setSelectedUserId("");
          setSelectedGroup(row);
        }}
        loading={groupsQuery.isLoading}
        errorMessage={groupsQuery.isError ? groupsQuery.error.message : null}
        onRetry={() => void groupsQuery.refetch()}
        emptyTitle="Nenhum grupo encontrado"
        emptyDescription="Nenhum grupo corresponde ao filtro informado."
        emptyActionLabel="Novo grupo"
        onEmptyAction={() => setCreateOpen(true)}
      />

      <Dialog
        open={createOpen}
        onClose={createGroupMutation.isPending ? undefined : () => setCreateOpen(false)}
        aria-labelledby={createTitleId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={createTitleId}>Criar grupo</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {createError ? (
              <Alert severity="error" role="alert">
                {createError}
              </Alert>
            ) : null}
            <TextField
              label="Nome do grupo"
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              fullWidth
              required
              inputProps={{ maxLength: 120 }}
              disabled={createGroupMutation.isPending}
            />
            <TextField
              label="Descrição (opcional)"
              value={groupDescription}
              onChange={(event) => setGroupDescription(event.target.value)}
              fullWidth
              multiline
              minRows={2}
              inputProps={{ maxLength: 500 }}
              disabled={createGroupMutation.isPending}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setCreateOpen(false)}
            disabled={createGroupMutation.isPending}
            variant="text"
          >
            Cancelar
          </Button>
          <Button
            onClick={() => void handleCreateGroup()}
            disabled={createGroupMutation.isPending}
            variant="contained"
          >
            {createGroupMutation.isPending ? "Criando..." : "Criar grupo"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={selectedGroup !== null}
        onClose={() => setSelectedGroup(null)}
        aria-labelledby={membersTitleId}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id={membersTitleId}>Membros do grupo: {selectedGroup?.name ?? ""}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {memberError ? (
              <Alert severity="error" role="alert">
                {memberError}
              </Alert>
            ) : null}

            <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems="stretch">
              <TextField
                select
                label="Associar usuário ativo"
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                fullWidth
                disabled={addMemberMutation.isPending || availableUsersToAdd.length === 0}
              >
                {availableUsersToAdd.length === 0 ? (
                  <MenuItem value="" disabled>
                    Nenhum usuário ativo disponível para associação
                  </MenuItem>
                ) : (
                  availableUsersToAdd.map((user) => (
                    <MenuItem key={user.id} value={user.id}>
                      {user.fullName} ({user.email})
                    </MenuItem>
                  ))
                )}
              </TextField>
              <Button
                variant="contained"
                startIcon={<PersonAddAltOutlinedIcon />}
                disabled={addMemberMutation.isPending || selectedUserId.trim().length === 0}
                onClick={() => void handleAssociateMember()}
                sx={{ whiteSpace: "nowrap" }}
              >
                {addMemberMutation.isPending ? "Associando..." : "Associar membro"}
              </Button>
            </Stack>

            <Divider />

            {membersQuery.isLoading ? (
              <LoadingState message="Carregando membros..." minHeight={100} />
            ) : membersQuery.isError ? (
              <Alert severity="error">{membersQuery.error.message}</Alert>
            ) : (membersQuery.data ?? []).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Este grupo ainda não possui usuários associados.
              </Typography>
            ) : (
              <List dense disablePadding>
                {(membersQuery.data ?? []).map((member) => (
                  <ListItem
                    key={member.id}
                    divider
                    secondaryAction={
                      <IconButton
                        edge="end"
                        color="error"
                        aria-label={`Remover ${member.fullName} do grupo`}
                        onClick={() => setMemberToRemove(member)}
                      >
                        <DeleteOutlineOutlinedIcon fontSize="small" />
                      </IconButton>
                    }
                  >
                    <ListItemText primary={member.fullName} secondary={member.email} />
                  </ListItem>
                ))}
              </List>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setSelectedGroup(null)} variant="text">
            Fechar
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={memberToRemove !== null}
        title="Remover membro do grupo"
        description={`Confirmar a remoção de "${memberToRemove?.fullName ?? ""}" do grupo "${selectedGroup?.name ?? ""}"?`}
        confirmLabel="Remover membro"
        confirmColor="error"
        loading={removeMemberMutation.isPending}
        onConfirm={() => void handleConfirmRemoveMember()}
        onCancel={() => setMemberToRemove(null)}
      />
    </Stack>
  );
}
