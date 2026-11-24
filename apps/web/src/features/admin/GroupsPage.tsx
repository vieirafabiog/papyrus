import type { GroupSummary, UserSummary } from "@docuflow/contracts";
import {
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  ErrorState,
  FilterBar,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
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
import { useI18n } from "../../i18n/index.js";
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

/**
 * Administrative group directory page supporting group creation, filtering,
 * and associating or disassociating users in groups according to permissions.
 */
export function GroupsPage() {
  const navigate = useNavigate();
  const { locale, t, formatDateTime } = useI18n();
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
      const cmp = a[sortBy].localeCompare(b[sortBy], locale);
      return sortDirection === "asc" ? cmp : -cmp;
    });
  }, [groupsQuery.data, search, sortBy, sortDirection, locale]);

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
    return <LoadingState message={t("admin.common.checkingPermissions")} />;
  }

  if (sessionQuery.data && !hasGroupAdminAccess) {
    return (
      <ErrorState
        title={t("admin.common.restrictedAccessTitle")}
        description={t("admin.groups.noAccessDescription")}
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
      setCreateError(t("admin.groups.validation.nameTooShort"));
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
        message: t("admin.groups.feedback.created", { name: created.name }),
      });
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : t("admin.groups.errors.createFailed"),
      );
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
        message: t("admin.groups.feedback.memberAdded", { name: selectedGroup.name }),
      });
    } catch (error) {
      setMemberError(
        error instanceof Error ? error.message : t("admin.groups.errors.addMemberFailed"),
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
        message: t("admin.groups.feedback.memberRemoved", {
          userName: memberToRemove.fullName,
          groupName: selectedGroup.name,
        }),
      });
      setMemberToRemove(null);
    } catch (error) {
      setMemberError(
        error instanceof Error ? error.message : t("admin.groups.errors.removeMemberFailed"),
      );
      setMemberToRemove(null);
    }
  };

  const columns: DataTableColumn<GroupSummary>[] = [
    {
      id: "name",
      label: t("admin.groups.table.name"),
      sortable: true,
      render: (row) => (
        <Typography variant="body2" fontWeight={500}>
          {row.name}
        </Typography>
      ),
    },
    {
      id: "description",
      label: t("admin.groups.table.description"),
      sortable: false,
      render: (row) => row.description ?? t("admin.groups.table.noDescription"),
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
          aria-label={t("admin.groups.actions.manageMembersAria", { name: row.name })}
        >
          {t("admin.groups.actions.manageMembers")}
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
          bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
        }}
      >
        <Stack spacing={1.5}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <GroupOutlinedIcon color="primary" />
              <Typography variant="h1">{t("admin.usersAndGroups.title")}</Typography>
            </Stack>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 0.5 }}>
              {t("admin.groups.subtitle")}
            </Typography>
          </Box>

          <Tabs
            value="groups"
            onChange={(_event, nextTab: string) => {
              if (nextTab === "users") {
                void navigate("/admin/users");
              }
            }}
            aria-label={t("admin.usersAndGroups.tabsAriaLabel")}
          >
            {hasUserAdminAccess || sessionQuery.data === null ? (
              <Tab value="users" label={t("admin.usersAndGroups.usersTab")} />
            ) : null}
            <Tab value="groups" label={t("admin.usersAndGroups.groupsTab")} />
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
        searchLabel={t("admin.groups.filters.searchLabel")}
        searchPlaceholder={t("admin.groups.filters.searchPlaceholder")}
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
            {t("admin.groups.actions.newGroup")}
          </Button>
        }
      />

      <DataTable
        ariaLabel={t("admin.groups.table.ariaLabel")}
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
        emptyTitle={t("admin.groups.table.emptyTitle")}
        emptyDescription={t("admin.groups.table.emptyDescription")}
        emptyActionLabel={t("admin.groups.actions.newGroup")}
        onEmptyAction={() => setCreateOpen(true)}
      />

      <Dialog
        open={createOpen}
        onClose={createGroupMutation.isPending ? undefined : () => setCreateOpen(false)}
        aria-labelledby={createTitleId}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle id={createTitleId}>{t("admin.groups.createDialog.title")}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 0.5 }}>
            {createError ? (
              <Alert severity="error" role="alert">
                {createError}
              </Alert>
            ) : null}
            <TextField
              label={t("admin.groups.createDialog.name")}
              value={groupName}
              onChange={(event) => setGroupName(event.target.value)}
              fullWidth
              required
              inputProps={{ maxLength: 120 }}
              disabled={createGroupMutation.isPending}
            />
            <TextField
              label={t("admin.groups.createDialog.description")}
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
            {t("admin.common.cancel")}
          </Button>
          <Button
            onClick={() => void handleCreateGroup()}
            disabled={createGroupMutation.isPending}
            variant="contained"
          >
            {createGroupMutation.isPending
              ? t("admin.common.creating")
              : t("admin.groups.createDialog.submit")}
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
        <DialogTitle id={membersTitleId}>
          {t("admin.groups.membersDialog.title", { name: selectedGroup?.name ?? "" })}
        </DialogTitle>
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
                label={t("admin.groups.membersDialog.selectUserLabel")}
                value={selectedUserId}
                onChange={(event) => setSelectedUserId(event.target.value)}
                fullWidth
                disabled={addMemberMutation.isPending || availableUsersToAdd.length === 0}
              >
                {availableUsersToAdd.length === 0 ? (
                  <MenuItem value="" disabled>
                    {t("admin.groups.membersDialog.noAvailableUsers")}
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
                {addMemberMutation.isPending
                  ? t("admin.groups.membersDialog.addingMember")
                  : t("admin.groups.membersDialog.addMember")}
              </Button>
            </Stack>

            <Divider />

            {membersQuery.isLoading ? (
              <LoadingState
                message={t("admin.groups.membersDialog.loadingMembers")}
                minHeight={100}
              />
            ) : membersQuery.isError ? (
              <Alert severity="error">{membersQuery.error.message}</Alert>
            ) : (membersQuery.data ?? []).length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                {t("admin.groups.membersDialog.emptyMembers")}
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
                        aria-label={t("admin.groups.membersDialog.removeMemberAria", {
                          name: member.fullName,
                        })}
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
            {t("admin.common.close")}
          </Button>
        </DialogActions>
      </Dialog>

      <ConfirmDialog
        open={memberToRemove !== null}
        title={t("admin.groups.confirmRemove.title")}
        description={t("admin.groups.confirmRemove.description", {
          userName: memberToRemove?.fullName ?? "",
          groupName: selectedGroup?.name ?? "",
        })}
        confirmLabel={t("admin.groups.confirmRemove.confirm")}
        confirmColor="error"
        loading={removeMemberMutation.isPending}
        onConfirm={() => void handleConfirmRemoveMember()}
        onCancel={() => setMemberToRemove(null)}
      />
    </Stack>
  );
}
