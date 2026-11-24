import type { WorkflowAssigneeCatalog, WorkflowAssigneeTarget } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import CloseOutlinedIcon from "@mui/icons-material/CloseOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import HistoryOutlinedIcon from "@mui/icons-material/HistoryOutlined";
import PowerSettingsNewOutlinedIcon from "@mui/icons-material/PowerSettingsNewOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import { WorkflowEditorDialog } from "./WorkflowEditorDialog.js";
import {
  useCreateWorkflowDefinitionMutation,
  usePublishWorkflowVersionMutation,
  useToggleWorkflowStatusMutation,
  useWorkflowAssigneeCatalogQuery,
  useWorkflowDefinitionDetailQuery,
  useWorkflowDefinitionsQuery,
} from "./useWorkflows.js";

const EMPTY_CATALOG: WorkflowAssigneeCatalog = { users: [], groups: [], roles: [] };

function formatAssigneeLabel(
  assignee: WorkflowAssigneeTarget,
  catalog: WorkflowAssigneeCatalog,
): { readonly kindLabel: string; readonly displayName: string } {
  if (assignee.type === "USER") {
    const user = catalog.users.find((item) => item.id === assignee.userId);
    return {
      kindLabel: "Usuário",
      displayName: user ? `${user.fullName} (${user.email})` : assignee.userId,
    };
  }
  if (assignee.type === "GROUP") {
    const group = catalog.groups.find((item) => item.id === assignee.groupId);
    return {
      kindLabel: "Grupo",
      displayName: group ? group.name : assignee.groupId,
    };
  }
  const role = catalog.roles.find((item) => item.id === assignee.roleId);
  return {
    kindLabel: "Papel",
    displayName: role ? role.name : assignee.roleId,
  };
}

/**
 * Versioned sequential workflow definitions management page (`/workflows`).
 */
export function WorkflowsPage() {
  const { data: session } = useSessionQuery();

  const canCreateWorkflow = Boolean(
    session &&
      (session.roles.some((role) => role.key === "admin") ||
        session.permissions.some(
          (perm) => perm.action === "CREATE" && perm.resource === "WORKFLOW",
        )),
  );
  const canUpdateWorkflow = Boolean(
    session &&
      (session.roles.some((role) => role.key === "admin") ||
        session.permissions.some(
          (perm) => perm.action === "UPDATE" && perm.resource === "WORKFLOW",
        )),
  );

  const [includeInactive, setIncludeInactive] = useState(false);
  const [search, setSearch] = useState("");
  const [feedback, setFeedback] = useState<{
    readonly severity: "success" | "error";
    readonly message: string;
  } | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [detailDefinitionId, setDetailDefinitionId] = useState<string | null>(null);
  const [versionEditDefinitionId, setVersionEditDefinitionId] = useState<string | null>(null);

  const definitionsQuery = useWorkflowDefinitionsQuery(includeInactive);
  const catalogQuery = useWorkflowAssigneeCatalogQuery(true);
  const detailQuery = useWorkflowDefinitionDetailQuery(
    detailDefinitionId ?? versionEditDefinitionId,
  );

  const createMutation = useCreateWorkflowDefinitionMutation();
  const publishVersionMutation = usePublishWorkflowVersionMutation();
  const toggleStatusMutation = useToggleWorkflowStatusMutation();

  const catalog = catalogQuery.data ?? EMPTY_CATALOG;
  const definitions = definitionsQuery.data ?? [];

  const filteredDefinitions = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (term.length === 0) {
      return definitions;
    }
    return definitions.filter(
      (def) =>
        def.name.toLowerCase().includes(term) ||
        (def.description ?? "").toLowerCase().includes(term),
    );
  }, [definitions, search]);

  const activeVersionSteps = useMemo(() => {
    if (!detailQuery.data || detailQuery.data.versions.length === 0) {
      return undefined;
    }
    const sorted = [...detailQuery.data.versions].sort((a, b) => b.versionNumber - a.versionNumber);
    return sorted[0]?.steps;
  }, [detailQuery.data]);

  const handleToggleStatus = async (definitionId: string, nextActive: boolean): Promise<void> => {
    setFeedback(null);
    try {
      const updated = await toggleStatusMutation.mutateAsync({
        definitionId,
        isActive: nextActive,
      });
      setFeedback({
        severity: "success",
        message: updated.isActive
          ? `Fluxo "${updated.name}" reativado com sucesso.`
          : `Fluxo "${updated.name}" desativado. Processos em andamento não foram afetados.`,
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        message:
          error instanceof Error ? error.message : "Não foi possível alterar o status do fluxo.",
      });
    }
  };

  return (
    <Stack spacing={2.5}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            Fluxos de aprovação
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Definições sequenciais versionadas de revisão e aprovação vinculadas à versão exata do
            documento.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={definitionsQuery.isFetching}
            onClick={() => void definitionsQuery.refetch()}
          >
            {definitionsQuery.isFetching ? "Atualizando..." : "Atualizar"}
          </Button>
          {canCreateWorkflow ? (
            <Button
              variant="contained"
              size="small"
              startIcon={<AddOutlinedIcon />}
              onClick={() => {
                setEditorError(null);
                setFeedback(null);
                setCreateOpen(true);
              }}
            >
              Novo fluxo
            </Button>
          ) : null}
        </Stack>
      </Stack>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)} role="alert">
          {feedback.message}
        </Alert>
      ) : null}

      <Paper
        sx={{
          p: 2,
          bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          justifyContent="space-between"
        >
          <TextField
            label="Filtrar definições de fluxo"
            placeholder="Nome ou descrição..."
            size="small"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            sx={{ minWidth: { sm: 280 } }}
          />
          <FormControlLabel
            control={
              <Switch
                checked={includeInactive}
                onChange={(event) => setIncludeInactive(event.target.checked)}
              />
            }
            label="Exibir fluxos inativos"
          />
        </Stack>
      </Paper>

      {definitionsQuery.isLoading ? (
        <LoadingState message="Carregando definições de fluxo de aprovação..." />
      ) : definitionsQuery.isError ? (
        <ErrorState
          description={definitionsQuery.error.message}
          onRetry={() => void definitionsQuery.refetch()}
        />
      ) : filteredDefinitions.length === 0 ? (
        <EmptyState
          title="Nenhum fluxo de aprovação cadastrado"
          description="Crie uma definição sequencial com etapas e aprovadores (usuário, grupo ou papel) para encaminhar documentos à revisão."
          {...(canCreateWorkflow
            ? {
                actionLabel: "Novo fluxo",
                onAction: () => {
                  setEditorError(null);
                  setCreateOpen(true);
                },
              }
            : {})}
        />
      ) : (
        <TableContainer
          component={Paper}
          sx={{ bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}
        >
          <Table aria-label="Tabela de definições de fluxos de aprovação" size="small">
            <TableHead>
              <TableRow>
                <TableCell>Definição</TableCell>
                <TableCell>Versão vigente</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Ações</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredDefinitions.map((def) => (
                <TableRow key={def.id} hover>
                  <TableCell>
                    <Typography variant="body2" fontWeight={500}>
                      {def.name}
                    </Typography>
                    {def.description ? (
                      <Typography variant="caption" color="text.secondary">
                        {def.description}
                      </Typography>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={`v${def.latestVersionNumber}`} variant="outlined" />
                  </TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={def.isActive ? "Ativo" : "Inativo"}
                      color={def.isActive ? "success" : "default"}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={1} justifyContent="flex-end">
                      <Button
                        size="small"
                        variant="text"
                        startIcon={<HistoryOutlinedIcon fontSize="small" />}
                        onClick={() => setDetailDefinitionId(def.id)}
                      >
                        Etapas e versões
                      </Button>

                      {canUpdateWorkflow && def.isActive ? (
                        <Button
                          size="small"
                          variant="outlined"
                          startIcon={<EditOutlinedIcon fontSize="small" />}
                          onClick={() => {
                            setEditorError(null);
                            setVersionEditDefinitionId(def.id);
                          }}
                        >
                          Nova versão
                        </Button>
                      ) : null}

                      {canUpdateWorkflow ? (
                        <Button
                          size="small"
                          variant="text"
                          color={def.isActive ? "warning" : "primary"}
                          startIcon={<PowerSettingsNewOutlinedIcon fontSize="small" />}
                          disabled={toggleStatusMutation.isPending}
                          onClick={() => void handleToggleStatus(def.id, !def.isActive)}
                        >
                          {def.isActive ? "Desativar" : "Reativar"}
                        </Button>
                      ) : null}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <WorkflowEditorDialog
        open={createOpen}
        mode="create"
        catalog={catalog}
        submitting={createMutation.isPending}
        serverError={editorError}
        onClose={() => setCreateOpen(false)}
        onSubmitCreate={async (payload) => {
          setEditorError(null);
          try {
            const created = await createMutation.mutateAsync({
              name: payload.name,
              description: payload.description,
              steps: [...payload.steps],
            });
            setCreateOpen(false);
            setFeedback({
              severity: "success",
              message: `Fluxo "${created.definition.name}" criado na versão v${created.version.versionNumber}.`,
            });
          } catch (error) {
            setEditorError(error instanceof Error ? error.message : "Erro ao criar fluxo.");
          }
        }}
        onSubmitNewVersion={async () => {}}
      />

      <WorkflowEditorDialog
        open={Boolean(versionEditDefinitionId) && Boolean(detailQuery.data)}
        mode="newVersion"
        existingName={detailQuery.data?.definition.name}
        existingDescription={detailQuery.data?.definition.description}
        initialSteps={activeVersionSteps}
        catalog={catalog}
        submitting={publishVersionMutation.isPending}
        serverError={editorError}
        onClose={() => setVersionEditDefinitionId(null)}
        onSubmitCreate={async () => {}}
        onSubmitNewVersion={async (payload) => {
          if (!versionEditDefinitionId) {
            return;
          }
          setEditorError(null);
          try {
            const published = await publishVersionMutation.mutateAsync({
              definitionId: versionEditDefinitionId,
              payload: { steps: [...payload.steps] },
            });
            setVersionEditDefinitionId(null);
            setFeedback({
              severity: "success",
              message: `Nova versão v${published.version.versionNumber} publicada para "${published.definition.name}".`,
            });
          } catch (error) {
            setEditorError(
              error instanceof Error ? error.message : "Erro ao publicar nova versão do fluxo.",
            );
          }
        }}
      />

      <Dialog
        open={Boolean(detailDefinitionId)}
        onClose={() => setDetailDefinitionId(null)}
        maxWidth="md"
        fullWidth
        aria-label="Detalhes das versões do fluxo"
      >
        <DialogTitle
          sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pb: 1 }}
        >
          <span>{detailQuery.data?.definition.name ?? "Detalhes do fluxo"}</span>
          <IconButton
            aria-label="Fechar detalhes do fluxo"
            onClick={() => setDetailDefinitionId(null)}
            size="small"
          >
            <CloseOutlinedIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent dividers>
          {detailQuery.isLoading ? (
            <LoadingState message="Carregando versões e etapas..." />
          ) : detailQuery.isError ? (
            <ErrorState
              description={detailQuery.error.message}
              onRetry={() => void detailQuery.refetch()}
            />
          ) : detailQuery.data ? (
            <Stack spacing={2.5}>
              {detailQuery.data.definition.description ? (
                <Typography variant="body2" color="text.secondary">
                  {detailQuery.data.definition.description}
                </Typography>
              ) : null}

              {[...detailQuery.data.versions]
                .sort((a, b) => b.versionNumber - a.versionNumber)
                .map((version) => (
                  <Paper
                    key={version.id}
                    variant="outlined"
                    sx={{ p: 2, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow }}
                  >
                    <Stack spacing={1.5}>
                      <Stack direction="row" alignItems="center" justifyContent="space-between">
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Typography variant="subtitle2">
                            Versão v{version.versionNumber}
                          </Typography>
                          {version.versionNumber ===
                          detailQuery.data.definition.latestVersionNumber ? (
                            <Chip size="small" label="Vigente" color="primary" />
                          ) : (
                            <Chip size="small" label="Histórica" variant="outlined" />
                          )}
                        </Stack>
                        <Typography variant="caption" color="text.secondary">
                          Criada em {new Date(version.createdAt).toLocaleString("pt-BR")}
                        </Typography>
                      </Stack>

                      <Divider />

                      <Stack spacing={1}>
                        {[...version.steps]
                          .sort((a, b) => a.stepOrder - b.stepOrder)
                          .map((step) => {
                            const assigneeInfo = formatAssigneeLabel(step.assignee, catalog);
                            return (
                              <Box
                                key={`${version.id}-${step.stepOrder}`}
                                sx={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  flexWrap: "wrap",
                                  gap: 1,
                                  py: 0.5,
                                }}
                              >
                                <Box>
                                  <Typography variant="body2" fontWeight={500}>
                                    {step.stepOrder}. {step.name}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary">
                                    {assigneeInfo.kindLabel}: {assigneeInfo.displayName}
                                    {step.commentRules?.requireOnApprove
                                      ? " • Comentário obrigatório na aprovação"
                                      : ""}
                                  </Typography>
                                </Box>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  label={
                                    step.dueDays !== null
                                      ? `Prazo: ${step.dueDays} ${step.dueDays === 1 ? "dia" : "dias"}`
                                      : "Sem prazo definido"
                                  }
                                />
                              </Box>
                            );
                          })}
                      </Stack>
                    </Stack>
                  </Paper>
                ))}
            </Stack>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setDetailDefinitionId(null)}>Fechar</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
