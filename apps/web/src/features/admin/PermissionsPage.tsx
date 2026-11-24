import type {
  AccessAction,
  AccessEffect,
  AccessResource,
  AccessScopeType,
  PermissionScopeAssignmentItem,
} from "@docuflow/contracts";
import {
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
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
import { type MessageKey, useI18n } from "../../i18n/index.js";
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

const RESOURCE_LABEL_KEYS: Readonly<Record<AccessResource, MessageKey>> = {
  DOCUMENT: "admin.permissions.resource.DOCUMENT",
  FOLDER: "admin.permissions.resource.FOLDER",
  CATEGORY: "admin.permissions.resource.CATEGORY",
  WORKFLOW: "admin.permissions.resource.WORKFLOW",
  USER: "admin.permissions.resource.USER",
  GROUP: "admin.permissions.resource.GROUP",
  ROLE: "admin.permissions.resource.ROLE",
  STORAGE: "admin.permissions.resource.STORAGE",
  AUDIT: "admin.permissions.resource.AUDIT",
  ORGANIZATION: "admin.permissions.resource.ORGANIZATION",
};

const ACTION_LABEL_KEYS: Readonly<Record<AccessAction, MessageKey>> = {
  READ: "admin.permissions.action.READ",
  CREATE: "admin.permissions.action.CREATE",
  UPDATE: "admin.permissions.action.UPDATE",
  DELETE: "admin.permissions.action.DELETE",
  UPLOAD: "admin.permissions.action.UPLOAD",
  DOWNLOAD: "admin.permissions.action.DOWNLOAD",
  APPROVE: "admin.permissions.action.APPROVE",
  REJECT: "admin.permissions.action.REJECT",
  MANAGE_PERMISSIONS: "admin.permissions.action.MANAGE_PERMISSIONS",
  MANAGE_STORAGE: "admin.permissions.action.MANAGE_STORAGE",
  MANAGE_USERS: "admin.permissions.action.MANAGE_USERS",
  VIEW_AUDIT: "admin.permissions.action.VIEW_AUDIT",
};

const SCOPE_LABEL_KEYS: Readonly<Record<AccessScopeType, MessageKey>> = {
  GLOBAL: "admin.permissions.scope.GLOBAL",
  CATEGORY: "admin.permissions.scope.CATEGORY",
  FOLDER: "admin.permissions.scope.FOLDER",
  DOCUMENT: "admin.permissions.scope.DOCUMENT",
};

const EFFECT_BADGE_CONFIG: Readonly<
  Record<AccessEffect, { readonly labelKey: MessageKey; readonly color: "success" | "error" }>
> = {
  ALLOW: { labelKey: "admin.permissions.effect.ALLOW", color: "success" },
  DENY: { labelKey: "admin.permissions.effect.DENY", color: "error" },
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

type TranslateFn = ReturnType<typeof useI18n>["t"];

function formatSubjectDisplay(
  row: PermissionScopeAssignmentItem,
  userById: ReadonlyMap<string, { readonly fullName: string; readonly email: string }>,
  groupById: ReadonlyMap<string, { readonly name: string }>,
  t: TranslateFn,
): string {
  if (row.userId !== null) {
    const user = userById.get(row.userId);
    return user
      ? t("admin.permissions.display.userPrefix", { name: user.fullName, email: user.email })
      : t("admin.permissions.display.organizationUser");
  }
  if (row.groupId !== null) {
    const group = groupById.get(row.groupId);
    return group
      ? t("admin.permissions.display.groupPrefix", { name: group.name })
      : t("admin.permissions.display.workGroup");
  }
  return t("admin.permissions.display.unknownSubject");
}

function formatTargetDisplay(
  row: PermissionScopeAssignmentItem,
  categoryById: ReadonlyMap<string, { readonly name: string }>,
  folderById: ReadonlyMap<string, { readonly name: string }>,
  t: TranslateFn,
): string {
  if (row.scopeType === "GLOBAL" || row.scopeTargetId === null) {
    return t("admin.permissions.display.entireOrganization");
  }
  if (row.scopeType === "CATEGORY") {
    return (
      categoryById.get(row.scopeTargetId)?.name ?? t("admin.permissions.display.selectedCategory")
    );
  }
  if (row.scopeType === "FOLDER") {
    const folderName =
      folderById.get(row.scopeTargetId)?.name ?? t("admin.permissions.display.selectedFolder");
    return t("admin.permissions.display.folderWithSubfolders", { name: folderName });
  }
  return t("admin.permissions.display.documentShort", {
    prefix: row.scopeTargetId.slice(0, 8),
  });
}

function formatRoleDisplay(
  roleId: string,
  roleById: ReadonlyMap<string, { readonly name: string }>,
  t: TranslateFn,
): string {
  return roleById.get(roleId)?.name ?? t("admin.permissions.display.assignedRole");
}

/**
 * Administrative RBAC & scoped ACL governance UI presenting a human-readable
 * role capability matrix, folder inheritance rules, and explicit ALLOW/DENY exceptions
 * without exposing raw SQL predicates or database internals.
 */
export function PermissionsPage() {
  const assignTitleId = useId();
  const { t, formatDateTime } = useI18n();

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
    formatSubjectDisplay(row, userById, groupById, t);

  const resolveTargetLabel = (row: PermissionScopeAssignmentItem): string =>
    formatTargetDisplay(row, categoryById, folderById, t);

  const resolveRoleLabel = (id: string): string => formatRoleDisplay(id, roleById, t);

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
        const subjectText = formatSubjectDisplay(row, userById, groupById, t).toLowerCase();
        const roleText = formatRoleDisplay(row.roleId, roleById, t).toLowerCase();
        const targetText = formatTargetDisplay(row, categoryById, folderById, t).toLowerCase();
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
    t,
  ]);

  const pagedAssignments = useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredAssignments.slice(start, start + pageSize);
  }, [filteredAssignments, page, pageSize]);

  if (sessionQuery.isLoading) {
    return <LoadingState message={t("admin.permissions.loading")} />;
  }

  if (sessionQuery.data && !hasPermissionAccess) {
    return (
      <ErrorState
        title={t("admin.common.restrictedAccessTitle")}
        description={t("admin.permissions.noAccessDescription")}
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
      setAssignError(t("admin.permissions.validation.selectRecipient"));
      return;
    }
    if (roleId.trim().length === 0) {
      setAssignError(t("admin.permissions.validation.selectRole"));
      return;
    }
    if (scopeType !== "GLOBAL" && scopeTargetId.trim().length === 0) {
      setAssignError(t("admin.permissions.validation.selectTarget"));
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
            ? t("admin.permissions.feedback.denyCreated")
            : t("admin.permissions.feedback.allowCreated"),
      });
    } catch (error) {
      setAssignError(
        error instanceof Error ? error.message : t("admin.permissions.errors.saveFailed"),
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
        message: t("admin.permissions.feedback.revoked"),
      });
    } catch (error) {
      setRevokeTarget(null);
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : t("admin.permissions.errors.revokeFailed"),
      });
    }
  };

  const assignmentColumns: DataTableColumn<PermissionScopeAssignmentItem>[] = [
    {
      id: "subject",
      label: t("admin.permissions.table.subject"),
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {resolveSubjectLabel(row)}
        </Typography>
      ),
    },
    {
      id: "roleId",
      label: t("admin.permissions.table.role"),
      render: (row) => resolveRoleLabel(row.roleId),
    },
    {
      id: "scopeType",
      label: t("admin.permissions.table.scope"),
      render: (row) => t(SCOPE_LABEL_KEYS[row.scopeType]),
    },
    {
      id: "target",
      label: t("admin.permissions.table.target"),
      render: (row) => resolveTargetLabel(row),
    },
    {
      id: "effect",
      label: t("admin.permissions.table.effect"),
      render: (row) => {
        const descriptor = EFFECT_BADGE_CONFIG[row.effect];
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
            label={t(descriptor.labelKey)}
          />
        );
      },
    },
    {
      id: "createdAt",
      label: t("admin.common.createdAt"),
      render: (row) => formatDateTime(row.createdAt),
    },
    {
      id: "actions",
      label: t("admin.common.actions"),
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
          aria-label={t("admin.permissions.actions.revokeAria", {
            subject: resolveSubjectLabel(row),
          })}
        >
          {t("admin.permissions.actions.revoke")}
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
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack direction="row" spacing={1.25} alignItems="center">
          <SecurityOutlinedIcon color="primary" />
          <Box>
            <Typography variant="h1">{t("admin.permissions.title")}</Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              {t("admin.permissions.subtitle")}
            </Typography>
          </Box>
        </Stack>
      </Paper>

      <Alert severity="info">
        <strong>{t("admin.permissions.inheritanceNoticeLead")}</strong>{" "}
        {t("admin.permissions.inheritanceNoticeBody")}
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
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Typography variant="h6" component="h2" gutterBottom>
          {t("admin.permissions.matrix.title")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("admin.permissions.matrix.subtitle")}
        </Typography>

        {rolesQuery.isLoading ? (
          <LoadingState message={t("admin.permissions.matrix.loading")} minHeight={120} />
        ) : rolesQuery.isError ? (
          <Alert severity="error">{rolesQuery.error.message}</Alert>
        ) : roles.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            {t("admin.permissions.matrix.empty")}
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label={t("admin.permissions.matrix.ariaLabel")}>
              <TableHead>
                <TableRow>
                  <TableCell>{t("admin.permissions.matrix.resourceHeader")}</TableCell>
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
                        {t(RESOURCE_LABEL_KEYS[resource])}
                      </Typography>
                    </TableCell>
                    {roles.map((role) => {
                      const actionsForResource = role.permissions
                        .filter((perm) => perm.resource === resource)
                        .map((perm) => t(ACTION_LABEL_KEYS[perm.action]));
                      return (
                        <TableCell key={role.id}>
                          {actionsForResource.length === 0 ? (
                            <Typography variant="caption" color="text.secondary">
                              {t("admin.permissions.matrix.noAccess")}
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
        searchLabel={t("admin.permissions.filters.searchLabel")}
        searchPlaceholder={t("admin.permissions.filters.searchPlaceholder")}
        filters={[
          {
            id: "effect-filter",
            label: t("admin.permissions.filters.effectLabel"),
            value: effectFilter,
            allOptionLabel: t("admin.permissions.filters.allEffects"),
            options: [
              { value: "ALLOW", label: t("admin.permissions.filters.effectAllow") },
              { value: "DENY", label: t("admin.permissions.filters.effectDeny") },
            ],
            onChange: (value) => {
              setEffectFilter(value as AccessEffect | "");
              setPage(1);
            },
          },
          {
            id: "scope-filter",
            label: t("admin.permissions.filters.scopeLabel"),
            value: scopeFilter,
            allOptionLabel: t("admin.permissions.filters.allScopes"),
            options: [
              { value: "GLOBAL", label: t("admin.permissions.filters.scopeGlobal") },
              { value: "CATEGORY", label: t("admin.permissions.filters.scopeCategory") },
              { value: "FOLDER", label: t("admin.permissions.filters.scopeFolder") },
              { value: "DOCUMENT", label: t("admin.permissions.filters.scopeDocument") },
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
            {t("admin.permissions.actions.newRule")}
          </Button>
        }
      />

      <DataTable
        ariaLabel={t("admin.permissions.table.ariaLabel")}
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
        emptyTitle={t("admin.permissions.table.emptyTitle")}
        emptyDescription={t("admin.permissions.table.emptyDescription")}
        emptyActionLabel={t("admin.permissions.actions.newRule")}
        onEmptyAction={handleOpenAssign}
      />

      <Dialog
        open={assignOpen}
        onClose={assignMutation.isPending ? undefined : () => setAssignOpen(false)}
        aria-labelledby={assignTitleId}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id={assignTitleId}>{t("admin.permissions.dialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {assignError ? (
              <Alert severity="error" role="alert">
                {assignError}
              </Alert>
            ) : null}

            <TextField
              select
              label={t("admin.permissions.dialog.recipientType")}
              value={subjectType}
              onChange={(event) => {
                setSubjectType(event.target.value as "USER" | "GROUP");
                setSubjectId("");
              }}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="USER">{t("admin.permissions.dialog.recipientUser")}</MenuItem>
              <MenuItem value="GROUP">{t("admin.permissions.dialog.recipientGroup")}</MenuItem>
            </TextField>

            <TextField
              select
              label={
                subjectType === "USER"
                  ? t("admin.permissions.dialog.selectUser")
                  : t("admin.permissions.dialog.selectGroup")
              }
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
              label={t("admin.permissions.dialog.role")}
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
              label={t("admin.permissions.dialog.effect")}
              value={effect}
              onChange={(event) => setEffect(event.target.value as AccessEffect)}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="ALLOW">{t("admin.permissions.dialog.effectAllow")}</MenuItem>
              <MenuItem value="DENY">{t("admin.permissions.dialog.effectDeny")}</MenuItem>
            </TextField>

            <TextField
              select
              label={t("admin.permissions.dialog.appliesTo")}
              value={scopeType}
              onChange={(event) => {
                setScopeType(event.target.value as AccessScopeType);
                setScopeTargetId("");
              }}
              fullWidth
              disabled={assignMutation.isPending}
            >
              <MenuItem value="GLOBAL">{t("admin.permissions.dialog.appliesToGlobal")}</MenuItem>
              <MenuItem value="CATEGORY">
                {t("admin.permissions.dialog.appliesToCategory")}
              </MenuItem>
              <MenuItem value="FOLDER">{t("admin.permissions.dialog.appliesToFolder")}</MenuItem>
              <MenuItem value="DOCUMENT">
                {t("admin.permissions.dialog.appliesToDocument")}
              </MenuItem>
            </TextField>

            {scopeType === "CATEGORY" ? (
              <TextField
                select
                label={t("admin.permissions.dialog.targetCategory")}
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
                label={t("admin.permissions.dialog.targetFolder")}
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
                label={t("admin.permissions.dialog.documentId")}
                value={scopeTargetId}
                onChange={(event) => setScopeTargetId(event.target.value)}
                fullWidth
                placeholder={t("admin.permissions.dialog.documentIdPlaceholder")}
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
            {t("admin.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleConfirmAssign()}
            disabled={assignMutation.isPending}
            variant="contained"
          >
            {assignMutation.isPending
              ? t("admin.common.saving")
              : t("admin.permissions.dialog.submit")}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        title={t("admin.permissions.confirmRevoke.title")}
        description={t("admin.permissions.confirmRevoke.description", {
          subject: revokeTarget ? resolveSubjectLabel(revokeTarget) : "",
        })}
        confirmLabel={t("admin.permissions.confirmRevoke.confirm")}
        confirmColor="error"
        loading={revokeMutation.isPending}
        onConfirm={() => void handleConfirmRevoke()}
        onCancel={() => setRevokeTarget(null)}
      />
    </Stack>
  );
}
