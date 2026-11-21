import type {
  AccessAction,
  AccessEffect,
  AccessResource,
  AccessScopeType,
  PermissionScopeAssignmentItem,
} from "@docuflow/contracts";
import {
  ConfirmDialog,
  DOCUFLOW_COLOR_TOKENS,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
} from "@docuflow/ui";
import AddModeratorOutlinedIcon from "@mui/icons-material/AddModeratorOutlined";
import CheckCircleOutlinedIcon from "@mui/icons-material/CheckCircleOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import GppBadOutlinedIcon from "@mui/icons-material/GppBadOutlined";
import SecurityOutlinedIcon from "@mui/icons-material/SecurityOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useId, useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import {
  canAdministerPermissions,
  useAssignPermissionScopeMutation,
  usePermissionAssignmentsQuery,
  usePermissionRolesQuery,
  useRevokePermissionScopeMutation,
  useScopeCategoriesQuery,
  useScopeFoldersQuery,
} from "./usePermissionsAdmin.js";
import { useAdminGroupsQuery, useAdminUsersQuery } from "./useUsersAndGroups.js";

const RESOURCE_LABELS: Readonly<Record<AccessResource, string>> = {
  DOCUMENT: "Documentos",
  FOLDER: "Pastas",
  CATEGORY: "Categorias",
  WORKFLOW: "Fluxos de aprovação",
  USER: "Usuários",
  GROUP: "Grupos",
  ROLE: "Papéis e escopos",
  STORAGE: "Armazenamento",
  AUDIT: "Auditoria",
  ORGANIZATION: "Organização",
};

const ACTION_LABELS: Readonly<Record<AccessAction, string>> = {
  READ: "Consultar",
  CREATE: "Criar",
  UPDATE: "Editar",
  DELETE: "Excluir",
  UPLOAD: "Enviar",
  DOWNLOAD: "Baixar",
  APPROVE: "Aprovar",
  REJECT: "Rejeitar",
  MANAGE_PERMISSIONS: "Administrar permissões",
  MANAGE_STORAGE: "Administrar armazenamento",
  MANAGE_USERS: "Gerenciar contas",
  VIEW_AUDIT: "Ver trilha de auditoria",
};

const SCOPE_LABELS: Readonly<Record<AccessScopeType, string>> = {
  GLOBAL: "Global da instalação",
  CATEGORY: "Categoria",
  FOLDER: "Pasta (com herança em subpastas)",
  DOCUMENT: "Documento específico",
};

const EFFECT_BADGE: Readonly<
  Record<AccessEffect, { readonly label: string; readonly color: "success" | "error" }>
> = {
  ALLOW: { label: "Permitir (concessão)", color: "success" },
  DENY: { label: "Negar (exceção)", color: "error" },
};

const ORDERED_RESOURCES: readonly AccessResource[] = [
  "DOCUMENT",
  "FOLDER",
  "CATEGORY",
  "WORKFLOW",
  "USER",
  "GROUP",
  "ROLE",
  "STORAGE",
  "AUDIT",
  "ORGANIZATION",
];

function formatDateTimePtBr(isoDateTime: string): string {
  const parsed = new Date(isoDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return isoDateTime;
  }
  return parsed.toLocaleString("pt-BR");
}

function formatSubjectDisplay(
  row: PermissionScopeAssignmentItem,
  userById: ReadonlyMap<string, { readonly fullName: string; readonly email: string }>,
  groupById: ReadonlyMap<string, { readonly name: string }>,
): string {
  if (row.userId !== null) {
    const user = userById.get(row.userId);
    return user ? `Usuário: ${user.fullName} (${user.email})` : "Usuário da organização";
  }
  if (row.groupId !== null) {
    const group = groupById.get(row.groupId);
    return group ? `Grupo: ${group.name}` : "Grupo de trabalho";
  }
  return "Sujeito não identificado";
}

function formatTargetDisplay(
  row: PermissionScopeAssignmentItem,
  categoryById: ReadonlyMap<string, { readonly name: string }>,
  folderById: ReadonlyMap<string, { readonly name: string }>,
): string {
  if (row.scopeType === "GLOBAL" || row.scopeTargetId === null) {
    return "Toda a instalação";
  }
  if (row.scopeType === "CATEGORY") {
    return categoryById.get(row.scopeTargetId)?.name ?? "Categoria selecionada";
  }
  if (row.scopeType === "FOLDER") {
    const folderName = folderById.get(row.scopeTargetId)?.name ?? "Pasta selecionada";
    return `${folderName} (herda subpastas)`;
  }
  return `Documento (${row.scopeTargetId.slice(0, 8)}…)`;
}

function formatRoleDisplay(
  roleId: string,
  roleById: ReadonlyMap<string, { readonly name: string }>,
): string {
  return roleById.get(roleId)?.name ?? "Papel atribuído";
}

/**
 * Administrative RBAC & scoped ACL governance UI presenting a human-readable
 * role capability matrix, folder inheritance rules, and explicit ALLOW/DENY exceptions
 * without exposing raw SQL predicates or database internals.
 */
export function PermissionsPage() {
  const assignTitleId = useId();

  const sessionQuery = useSessionQuery();
  const hasPermissionAccess =
    sessionQuery.data === undefined ? true : canAdministerPermissions(sessionQuery.data);
  const canQuery = !sessionQuery.isLoading && (sessionQuery.data === null || hasPermissionAccess);

  const rolesQuery = usePermissionRolesQuery(canQuery);
  const assignmentsQuery = usePermissionAssignmentsQuery(canQuery);
  const usersQuery = useAdminUsersQuery(canQuery);
  const groupsQuery = useAdminGroupsQuery(canQuery);
  const categoriesQuery = useScopeCategoriesQuery(canQuery);
  const foldersQuery = useScopeFoldersQuery(canQuery);

  const assignMutation = useAssignPermissionScopeMutation();
  const revokeMutation = useRevokePermissionScopeMutation();

  const [search, setSearch] = useState("");
  const [effectFilter, setEffectFilter] = useState<AccessEffect | "">("");
  const [scopeFilter, setScopeFilter] = useState<AccessScopeType | "">("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const [assignOpen, setAssignOpen] = useState(false);
  const [subjectType, setSubjectType] = useState<"USER" | "GROUP">("USER");
  const [subjectId, setSubjectId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [scopeType, setScopeType] = useState<AccessScopeType>("GLOBAL");
  const [scopeTargetId, setScopeTargetId] = useState("");
  const [effect, setEffect] = useState<AccessEffect>("ALLOW");
  const [assignError, setAssignError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<PermissionScopeAssignmentItem | null>(null);
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const roleById = useMemo(
    () => new Map((rolesQuery.data ?? []).map((role) => [role.id, role])),
    [rolesQuery.data],
  );
  const userById = useMemo(
    () => new Map((usersQuery.data ?? []).map((user) => [user.id, user])),
    [usersQuery.data],
  );
  const groupById = useMemo(
    () => new Map((groupsQuery.data ?? []).map((group) => [group.id, group])),
    [groupsQuery.data],
  );
  const categoryById = useMemo(
    () => new Map((categoriesQuery.data ?? []).map((cat) => [cat.id, cat])),
    [categoriesQuery.data],
  );
  const folderById = useMemo(
    () => new Map((foldersQuery.data ?? []).map((folder) => [folder.id, folder])),
    [foldersQuery.data],
  );

  const resolveSubjectLabel = (row: PermissionScopeAssignmentItem): string =>
    formatSubjectDisplay(row, userById, groupById);

  const resolveTargetLabel = (row: PermissionScopeAssignmentItem): string =>
    formatTargetDisplay(row, categoryById, folderById);

  const resolveRoleLabel = (id: string): string => formatRoleDisplay(id, roleById);

  const filteredAssignments = useMemo(() => {
    const items = assignmentsQuery.data ?? [];
    const term = search.trim().toLowerCase();
    return items.filter((row) => {
      if (effectFilter.length > 0 && row.effect !== effectFilter) {
        return false;
      }
      if (scopeFilter.length > 0 && row.scopeType !== scopeFilter) {
        return false;
      }
      if (term.length > 0) {
        const subjectText = formatSubjectDisplay(row, userById, groupById).toLowerCase();
        const roleText = formatRoleDisplay(row.roleId, roleById).toLowerCase();
        const targetText = formatTargetDisplay(row, categoryById, folderById).toLowerCase();
        return subjectText.includes(term) || roleText.includes(term) || targetText.includes(term);
      }
      return true;
    });
  }, [
    assignmentsQuery.data,
    effectFilter,
    scopeFilter,
    search,
    userById,
    groupById,
    roleById,
    categoryById,
    folderById,
  ]);

  const pagedAssignments = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredAssignments.slice(start, start + pageSize);
  }, [filteredAssignments, page, pageSize]);

  if (sessionQuery.isLoading) {
    return <LoadingState message="Verificando permissões de governança..." />;
  }

  if (sessionQuery.data && !hasPermissionAccess) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para visualizar ou alterar papéis e escopos de acesso."
      />
    );
  }

  const handleOpenAssign = (): void => {
    setAssignError(null);
    setSubjectType("USER");
    setSubjectId("");
    setRoleId(rolesQuery.data?.[0]?.id ?? "");
    setScopeType("GLOBAL");
    setScopeTargetId("");
    setEffect("ALLOW");
    setAssignOpen(true);
  };

  const handleConfirmAssign = async (): Promise<void> => {
    setAssignError(null);
    if (subjectId.trim().length === 0) {
      setAssignError("Selecione o usuário ou grupo de destino.");
      return;
    }
    if (roleId.trim().length === 0) {
      setAssignError("Selecione o papel a ser atribuído.");
      return;
    }
    if (scopeType !== "GLOBAL" && scopeTargetId.trim().length === 0) {
      setAssignError("Selecione ou informe o recurso alvo para este escopo.");
      return;
    }

    try {
      await assignMutation.mutateAsync({
        subjectType,
        subjectId,
        roleId,
        scopeType,
        scopeTargetId: scopeType === "GLOBAL" ? null : scopeTargetId.trim(),
        effect,
      });
      setAssignOpen(false);
      setFeedback({
        severity: "success",
        message:
          effect === "DENY"
            ? "Exceção de bloqueio registrada com sucesso."
            : "Concessão de permissão registrada com sucesso.",
      });
    } catch (error) {
      setAssignError(
        error instanceof Error ? error.message : "Não foi possível salvar a regra de permissão.",
      );
    }
  };

  const handleConfirmRevoke = async (): Promise<void> => {
    if (!revokeTarget) {
      return;
    }
    try {
      await revokeMutation.mutateAsync(revokeTarget.id);
      setRevokeTarget(null);
      setFeedback({
        severity: "success",
        message: "Atribuição de permissão revogada com sucesso.",
      });
    } catch (error) {
      setRevokeTarget(null);
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : "Não foi possível revogar a regra selecionada.",
      });
    }
  };

  const assignmentColumns: DataTableColumn<PermissionScopeAssignmentItem>[] = [
    {
      id: "subject",
      label: "Usuário ou grupo",
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {resolveSubjectLabel(row)}
        </Typography>
      ),
    },
    {
      id: "roleId",
      label: "Papel",
      render: (row) => resolveRoleLabel(row.roleId),
    },
    {
      id: "scopeType",
      label: "Escopo",
      render: (row) => SCOPE_LABELS[row.scopeType],
    },
    {
      id: "target",
      label: "Alvo / Herança",
      render: (row) => resolveTargetLabel(row),
    },
    {
      id: "effect",
      label: "Regra",
      render: (row) => {
        const descriptor = EFFECT_BADGE[row.effect];
        return (
          <Chip
            size="small"
            color={descriptor.color}
            icon={
              row.effect === "DENY" ? (
                <GppBadOutlinedIcon fontSize="small" />
              ) : (
                <CheckCircleOutlinedIcon fontSize="small" />
              )
            }
            label={descriptor.label}
          />
        );
      },
    },
    {
      id: "createdAt",
      label: "Criada em",
      render: (row) => formatDateTimePtBr(row.createdAt),
    },
    {
      id: "actions",
      label: "Ações",
      align: "right",
      render: (row) => (
        <Button
          size="small"
          variant="text"
          color="error"
          startIcon={<DeleteOutlineOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            setRevokeTarget(row);
          }}
          aria-label={`Revogar regra de ${resolveSubjectLabel(row)}`}
        >
          Revogar
        </Button>
      ),
    },
  ];

  const roles = rolesQuery.data ?? [];

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
        <Stack direction="row" spacing={1.25} alignItems="center">
          <SecurityOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h1">Papéis, herança e exceções de acesso</Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              Visualize a matriz de capacidades por papel e gerencie concessões e bloqueios
              explícitos por escopo.
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Alert severity="info">
        <strong>Regras de herança e precedência:</strong> permissões concedidas em uma pasta são
        herdadas pelas subpastas descendentes. Quando houver conflito, uma exceção explícita de{" "}
        <strong>Negação</strong> sempre prevalece sobre qualquer concessão herdada, seja por usuário
        ou por grupo.
      </Alert>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.message}
        </Alert>
      ) : null}

      <Paper
        variant="outlined"
        sx={{
          p: 2.5,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Typography variant="h6" component="h2" gutterBottom>
          Matriz compreensível de permissões por papel
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Resumo funcional das ações autorizadas para cada papel do sistema nesta organização.
        </Typography>

        {rolesQuery.isLoading ? (
          <LoadingState message="Carregando matriz de papéis..." minHeight={120} />
        ) : rolesQuery.isError ? (
          <Alert severity="error">{rolesQuery.error.message}</Alert>
        ) : roles.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Nenhum catálogo de papéis detalhado disponível para exibição no momento.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Matriz de permissões por papel">
              <TableHead>
                <TableRow>
                  <TableCell>Recurso</TableCell>
                  {roles.map((role) => (
                    <TableCell key={role.id}>
                      <Typography variant="body2" fontWeight={600}>
                        {role.name}
                      </Typography>
                      {role.description ? (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {role.description}
                        </Typography>
                      ) : null}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {ORDERED_RESOURCES.map((resource) => (
                  <TableRow key={resource} hover>
                    <TableCell component="th" scope="row">
                      <Typography variant="body2" fontWeight={500}>
                        {RESOURCE_LABELS[resource]}
                      </Typography>
                    </TableCell>
                    {roles.map((role) => {
                      const actionsForResource = role.permissions
                        .filter((perm) => perm.resource === resource)
                        .map((perm) => ACTION_LABELS[perm.action]);
                      return (
                        <TableCell key={role.id}>
                          {actionsForResource.length === 0 ? (
                            <Typography variant="caption" color="text.secondary">
                              Sem acesso
                            </Typography>
                          ) : (
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                              {actionsForResource.map((label) => (
                                <Chip key={label} label={label} size="small" variant="outlined" />
                              ))}
                            </Stack>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      <FilterBar
        searchValue={search}
        onSearchChange={(value) => {
          setSearch(value);
          setPage(1);
        }}
        searchLabel="Filtrar regras de escopo"
        searchPlaceholder="Usuário, grupo, papel ou destino..."
        filters={[
          {
            id: "effect-filter",
            label: "Tipo de regra",
            value: effectFilter,
            allOptionLabel: "Concessões e exceções",
            options: [
              { value: "ALLOW", label: "Concessões (Permitir)" },
              { value: "DENY", label: "Exceções (Negar)" },
            ],
            onChange: (value) => {
              setEffectFilter(value as AccessEffect | "");
              setPage(1);
            },
          },
          {
            id: "scope-filter",
            label: "Escopo",
            value: scopeFilter,
            allOptionLabel: "Todos os escopos",
            options: [
              { value: "GLOBAL", label: "Global da instalação" },
              { value: "CATEGORY", label: "Categoria" },
              { value: "FOLDER", label: "Pasta (herança)" },
              { value: "DOCUMENT", label: "Documento" },
            ],
            onChange: (value) => {
              setScopeFilter(value as AccessScopeType | "");
              setPage(1);
            },
          },
        ]}
        hasActiveFilters={
          search.trim().length > 0 || effectFilter.length > 0 || scopeFilter.length > 0
        }
        onClearFilters={() => {
          setSearch("");
          setEffectFilter("");
          setScopeFilter("");
          setPage(1);
        }}
        actions={
          <Button
            variant="contained"
            startIcon={<AddModeratorOutlinedIcon />}
            onClick={handleOpenAssign}
          >
            Nova regra ou exceção
          </Button>
        }
      />

      <DataTable
        ariaLabel="Tabela de atribuições e exceções de permissão"
        columns={assignmentColumns}
        rows={pagedAssignments}
        getRowId={(row) => row.id}
        getRowLabel={(row) => `${resolveSubjectLabel(row)} — ${resolveRoleLabel(row.roleId)}`}
        page={page}
        pageSize={pageSize}
        totalItems={filteredAssignments.length}
        onPageChange={setPage}
        onPageSizeChange={(nextSize) => {
          setPageSize(nextSize);
          setPage(1);
        }}
        loading={assignmentsQuery.isLoading}
        errorMessage={assignmentsQuery.isError ? assignmentsQuery.error.message : null}
        onRetry={() => void assignmentsQuery.refetch()}
        emptyTitle="Nenhuma atribuição ou exceção encontrada"
        emptyDescription="Nenhuma regra de escopo corresponde aos filtros aplicados."
        emptyActionLabel="Nova regra ou exceção"
        onEmptyAction={handleOpenAssign}
      />

      <Dialog
        open={assignOpen}
        onClose={assignMutation.isPending ? undefined : () => setAssignOpen(false)}
        aria-labelledby={assignTitleId}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id={assignTitleId}>Atribuir papel ou registrar exceção</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {assignError ? (
              <Alert severity="error" role="alert">
                {assignError}
              </Alert>
            ) : null}

            <TextField
              select
              label="Tipo de destinatário"
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.target.value as "USER" | "GROUP");
                setSubjectId("");
              }}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="USER">Usuário</MenuItem>
              <MenuItem value="GROUP">Grupo de trabalho</MenuItem>
            </TextField>

            <TextField
              select
              label={subjectType === "USER" ? "Selecionar usuário" : "Selecionar grupo"}
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              fullWidth
              disabled={assignMutation.isPending}
            >
              {subjectType === "USER"
                ? (usersQuery.data ?? []).map((user) => (
                    <MenuItem key={user.id} value={user.id}>
                      {user.fullName} ({user.email})
                    </MenuItem>
                  ))
                : (groupsQuery.data ?? []).map((group) => (
                    <MenuItem key={group.id} value={group.id}>
                      {group.name}
                    </MenuItem>
                  ))}
            </TextField>

            <TextField
              select
              label="Papel"
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              fullWidth
              disabled={assignMutation.isPending}
            >
              {roles.map((role) => (
                <MenuItem key={role.id} value={role.id}>
                  {role.name}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              select
              label="Efeito da regra"
              value={effect}
              onChange={(event) => setEffect(event.target.value as AccessEffect)}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="ALLOW">Permitir acesso (concessão)</MenuItem>
              <MenuItem value="DENY">Negar acesso (exceção explícita)</MenuItem>
            </TextField>

            <TextField
              select
              label="Escopo de aplicação"
              value={scopeType}
              onChange={(event) => {
                setScopeType(event.target.value as AccessScopeType);
                setScopeTargetId("");
              }}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="GLOBAL">Global da instalação</MenuItem>
              <MenuItem value="CATEGORY">Categoria documental</MenuItem>
              <MenuItem value="FOLDER">Pasta (herda subpastas)</MenuItem>
              <MenuItem value="DOCUMENT">Documento específico</MenuItem>
            </TextField>

            {scopeType === "CATEGORY" ? (
              <TextField
                select
                label="Categoria alvo"
                value={scopeTargetId}
                onChange={(event) => setScopeTargetId(event.target.value)}
                fullWidth
                disabled={assignMutation.isPending}
              >
                {(categoriesQuery.data ?? []).map((cat) => (
                  <MenuItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </MenuItem>
                ))}
              </TextField>
            ) : scopeType === "FOLDER" ? (
              <TextField
                select
                label="Pasta alvo"
                value={scopeTargetId}
                onChange={(event) => setScopeTargetId(event.target.value)}
                fullWidth
                disabled={assignMutation.isPending}
              >
                {(foldersQuery.data ?? []).map((folder) => (
                  <MenuItem key={folder.id} value={folder.id}>
                    {folder.name}
                  </MenuItem>
                ))}
              </TextField>
            ) : scopeType === "DOCUMENT" ? (
              <TextField
                label="Identificador do documento"
                value={scopeTargetId}
                onChange={(event) => setScopeTargetId(event.target.value)}
                fullWidth
                placeholder="UUID do documento alvo"
                disabled={assignMutation.isPending}
              />
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setAssignOpen(false)}
            disabled={assignMutation.isPending}
            variant="text"
          >
            Cancelar
          </Button>
          <Button
            onClick={() => void handleConfirmAssign()}
            disabled={assignMutation.isPending}
            variant="contained"
          >
            {assignMutation.isPending ? "Salvando..." : "Salvar regra"}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revogar regra de acesso"
        description={`Confirmar a remoção desta regra para "${revokeTarget ? resolveSubjectLabel(revokeTarget) : ""}"?`}
        confirmLabel="Confirmar revogação"
        confirmColor="error"
        loading={revokeMutation.isPending}
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </Stack>
  );
}
