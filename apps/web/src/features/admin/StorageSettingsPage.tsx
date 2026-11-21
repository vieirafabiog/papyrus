import type {
  CategorySummaryRecord,
  CreateStorageConnectionContract,
  StorageConnectionKindContract,
  StorageConnectionStatusContract,
  StorageConnectionViewContract,
  StorageRoutingRuleViewContract,
  UpdateStorageConnectionContract,
} from "@docuflow/contracts";
import {
  createStorageConnectionContractSchema,
  updateStorageConnectionContractSchema,
} from "@docuflow/contracts";
import {
  ConfirmDialog,
  DOCUFLOW_COLOR_TOKENS,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@docuflow/ui";
import AddOutlinedIcon from "@mui/icons-material/AddOutlined";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import DeleteOutlineOutlinedIcon from "@mui/icons-material/DeleteOutlineOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import HealthAndSafetyOutlinedIcon from "@mui/icons-material/HealthAndSafetyOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import RouteOutlinedIcon from "@mui/icons-material/RouteOutlined";
import StarOutlineOutlinedIcon from "@mui/icons-material/StarOutlineOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
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
  Grid,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { type FormEvent, useId, useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import {
  canManageStorage,
  useClearCategoryRoutingRuleMutation,
  useCreateStorageConnectionMutation,
  useSetDefaultStorageConnectionMutation,
  useStorageCategoriesQuery,
  useStorageConnectionsQuery,
  useStorageRoutingRulesQuery,
  useTestStorageConnectionMutation,
  useToggleStorageConnectionStatusMutation,
  useUpdateStorageConnectionMutation,
  useUpsertStorageRoutingRuleMutation,
} from "./useStorageSettings.js";

const CONNECTION_KIND_LABELS: Readonly<Record<StorageConnectionKindContract, string>> = {
  local: "Armazenamento local",
  s3: "S3 compatível",
  azure_blob: "Azure Blob",
  google_cloud: "Google Cloud Storage",
};

const CONNECTION_STATUS_BADGE: Readonly<
  Record<
    StorageConnectionStatusContract,
    { readonly label: string; readonly color: "success" | "default" | "error" }
  >
> = {
  ACTIVE: { label: "Ativa", color: "success" },
  INACTIVE: { label: "Inativa", color: "default" },
  ERROR: { label: "Com falha", color: "error" },
};

type EditableKind = "local" | "s3";

interface ConnectionFormState {
  readonly kind: EditableKind;
  readonly name: string;
  readonly isDefault: boolean;
  readonly rootDirectory: string;
  readonly maxObjectSizeBytes: string;
  readonly minFreeBytes: string;
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly keyPrefix: string;
  readonly forcePathStyle: boolean;
  readonly rejectUnauthorized: boolean;
  readonly allowInsecureHttp: boolean;
  readonly caCertificatePem: string;
  readonly connectionTimeoutMs: string;
  readonly requestTimeoutMs: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

interface FeedbackMessage {
  readonly severity: "success" | "error" | "info";
  readonly text: string;
}

function readConfigString(
  config: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
  fallback = "",
): string {
  const value = config[key];
  return typeof value === "string" ? value : fallback;
}

function readConfigNumberString(
  config: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
  fallback = "",
): string {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}

function readConfigBoolean(
  config: Readonly<Record<string, string | number | boolean | null>>,
  key: string,
  fallback: boolean,
): boolean {
  const value = config[key];
  return typeof value === "boolean" ? value : fallback;
}

function createEmptyFormState(kind: EditableKind = "local"): ConnectionFormState {
  return {
    kind,
    name: "",
    isDefault: false,
    rootDirectory: "",
    maxObjectSizeBytes: "",
    minFreeBytes: "",
    endpoint: "",
    region: "us-east-1",
    bucket: "",
    keyPrefix: "",
    forcePathStyle: false,
    rejectUnauthorized: true,
    allowInsecureHttp: false,
    caCertificatePem: "",
    connectionTimeoutMs: "5000",
    requestTimeoutMs: "30000",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}

function formStateFromConnection(connection: StorageConnectionViewContract): ConnectionFormState {
  const kind: EditableKind = connection.kind === "s3" ? "s3" : "local";
  const config = connection.nonSecretConfig;
  return {
    kind,
    name: connection.name,
    isDefault: connection.isDefault,
    rootDirectory: readConfigString(config, "rootDirectory"),
    maxObjectSizeBytes: readConfigNumberString(config, "maxObjectSizeBytes"),
    minFreeBytes: readConfigNumberString(config, "minFreeBytes"),
    endpoint: readConfigString(config, "endpoint"),
    region: readConfigString(config, "region", "us-east-1"),
    bucket: readConfigString(config, "bucket"),
    keyPrefix: readConfigString(config, "keyPrefix"),
    forcePathStyle: readConfigBoolean(config, "forcePathStyle", false),
    rejectUnauthorized: readConfigBoolean(config, "tlsRejectUnauthorized", true),
    allowInsecureHttp: readConfigBoolean(config, "tlsAllowInsecureHttp", false),
    caCertificatePem: readConfigString(config, "caCertificatePem"),
    connectionTimeoutMs: readConfigNumberString(config, "connectionTimeoutMs", "5000"),
    requestTimeoutMs: readConfigNumberString(config, "requestTimeoutMs", "30000"),
    // Credentials are never returned by the backend; fields stay empty unless rotated.
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
  };
}

function parseOptionalInt(rawValue: string): number | undefined {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function formatDateTimePtBr(value: string | null): string {
  if (!value) {
    return "Nunca verificada";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function describeNonSecretTarget(connection: StorageConnectionViewContract): string {
  const config = connection.nonSecretConfig;
  if (connection.kind === "local") {
    const rootDirectory = readConfigString(config, "rootDirectory", "—");
    return `Diretório: ${rootDirectory}`;
  }
  const bucket = readConfigString(config, "bucket", "—");
  const endpoint = readConfigString(config, "endpoint", "—");
  const region = readConfigString(config, "region", "—");
  const prefix = readConfigString(config, "keyPrefix");
  return prefix
    ? `${bucket} (${region}) • ${endpoint} • prefixo ${prefix}`
    : `${bucket} (${region}) • ${endpoint}`;
}

function validateAndBuildCreatePayload(form: ConnectionFormState): {
  readonly payload?: CreateStorageConnectionContract;
  readonly error?: string;
} {
  if (form.kind === "local") {
    const maxObjectSizeBytes = parseOptionalInt(form.maxObjectSizeBytes);
    if (
      maxObjectSizeBytes !== undefined &&
      (Number.isNaN(maxObjectSizeBytes) || maxObjectSizeBytes <= 0)
    ) {
      return { error: "Informe um tamanho máximo por objeto inteiro e positivo." };
    }
    const minFreeBytes = parseOptionalInt(form.minFreeBytes);
    if (minFreeBytes !== undefined && (Number.isNaN(minFreeBytes) || minFreeBytes < 0)) {
      return { error: "Informe um espaço livre mínimo inteiro e não negativo." };
    }
    const parsed = createStorageConnectionContractSchema.safeParse({
      kind: "local",
      name: form.name.trim(),
      rootDirectory: form.rootDirectory.trim(),
      ...(form.isDefault ? { isDefault: true } : {}),
      ...(maxObjectSizeBytes !== undefined ? { maxObjectSizeBytes } : {}),
      ...(minFreeBytes !== undefined ? { minFreeBytes } : {}),
    });
    if (!parsed.success) {
      return {
        error:
          parsed.error.issues[0]?.message ?? "Dados inválidos para conexão de armazenamento local.",
      };
    }
    return { payload: parsed.data };
  }

  const connectionTimeoutMs = parseOptionalInt(form.connectionTimeoutMs) ?? 5_000;
  const requestTimeoutMs = parseOptionalInt(form.requestTimeoutMs) ?? 30_000;
  if (Number.isNaN(connectionTimeoutMs) || Number.isNaN(requestTimeoutMs)) {
    return { error: "Informe timeouts numéricos válidos em milissegundos." };
  }

  const parsed = createStorageConnectionContractSchema.safeParse({
    kind: "s3",
    name: form.name.trim(),
    endpoint: form.endpoint.trim(),
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    forcePathStyle: form.forcePathStyle,
    ...(form.keyPrefix.trim() ? { keyPrefix: form.keyPrefix.trim() } : {}),
    tls: {
      rejectUnauthorized: form.rejectUnauthorized,
      allowInsecureHttp: form.allowInsecureHttp,
      ...(form.caCertificatePem.trim() ? { caCertificatePem: form.caCertificatePem.trim() } : {}),
    },
    timeouts: {
      connectionTimeoutMs,
      requestTimeoutMs,
    },
    credentials: {
      accessKeyId: form.accessKeyId.trim(),
      secretAccessKey: form.secretAccessKey,
      ...(form.sessionToken.trim() ? { sessionToken: form.sessionToken.trim() } : {}),
    },
    ...(form.isDefault ? { isDefault: true } : {}),
  });
  if (!parsed.success) {
    return {
      error: parsed.error.issues[0]?.message ?? "Dados inválidos para conexão S3 compatível.",
    };
  }
  return { payload: parsed.data };
}

function validateAndBuildUpdatePayload(form: ConnectionFormState): {
  readonly payload?: UpdateStorageConnectionContract;
  readonly error?: string;
} {
  if (form.kind === "local") {
    const maxObjectSizeBytes = parseOptionalInt(form.maxObjectSizeBytes);
    if (
      maxObjectSizeBytes !== undefined &&
      (Number.isNaN(maxObjectSizeBytes) || maxObjectSizeBytes <= 0)
    ) {
      return { error: "Informe um tamanho máximo por objeto inteiro e positivo." };
    }
    const minFreeBytes = parseOptionalInt(form.minFreeBytes);
    if (minFreeBytes !== undefined && (Number.isNaN(minFreeBytes) || minFreeBytes < 0)) {
      return { error: "Informe um espaço livre mínimo inteiro e não negativo." };
    }

    const parsed = updateStorageConnectionContractSchema.safeParse({
      name: form.name.trim(),
      rootDirectory: form.rootDirectory.trim(),
      ...(maxObjectSizeBytes !== undefined ? { maxObjectSizeBytes } : {}),
      ...(minFreeBytes !== undefined ? { minFreeBytes } : {}),
    });
    if (!parsed.success) {
      return {
        error:
          parsed.error.issues[0]?.message ??
          "Dados inválidos ao atualizar conexão de armazenamento local.",
      };
    }
    return { payload: parsed.data };
  }

  const hasAccessKey = form.accessKeyId.trim().length > 0;
  const hasSecretKey = form.secretAccessKey.length > 0;
  const hasSessionToken = form.sessionToken.trim().length > 0;
  if ((hasAccessKey || hasSecretKey || hasSessionToken) && !(hasAccessKey && hasSecretKey)) {
    return {
      error: "Para rotacionar credenciais S3, informe Access Key ID e Secret Access Key.",
    };
  }

  const connectionTimeoutMs = parseOptionalInt(form.connectionTimeoutMs) ?? 5_000;
  const requestTimeoutMs = parseOptionalInt(form.requestTimeoutMs) ?? 30_000;
  if (Number.isNaN(connectionTimeoutMs) || Number.isNaN(requestTimeoutMs)) {
    return { error: "Informe timeouts numéricos válidos em milissegundos." };
  }

  const parsed = updateStorageConnectionContractSchema.safeParse({
    name: form.name.trim(),
    endpoint: form.endpoint.trim(),
    region: form.region.trim(),
    bucket: form.bucket.trim(),
    forcePathStyle: form.forcePathStyle,
    keyPrefix: form.keyPrefix.trim() ? form.keyPrefix.trim() : null,
    tls: {
      rejectUnauthorized: form.rejectUnauthorized,
      allowInsecureHttp: form.allowInsecureHttp,
      ...(form.caCertificatePem.trim() ? { caCertificatePem: form.caCertificatePem.trim() } : {}),
    },
    timeouts: {
      connectionTimeoutMs,
      requestTimeoutMs,
    },
    ...(hasAccessKey && hasSecretKey
      ? {
          credentials: {
            accessKeyId: form.accessKeyId.trim(),
            secretAccessKey: form.secretAccessKey,
            ...(hasSessionToken ? { sessionToken: form.sessionToken.trim() } : {}),
          },
        }
      : {}),
  });
  if (!parsed.success) {
    return {
      error:
        parsed.error.issues[0]?.message ?? "Dados inválidos ao atualizar conexão S3 compatível.",
    };
  }
  return { payload: parsed.data };
}

/**
 * Administrative page for managing local and S3 storage connections, health checks,
 * default destination selection, masked credential rotation, and category routing rules.
 */
export function StorageSettingsPage() {
  const sessionQuery = useSessionQuery();
  const hasStorageAccess = canManageStorage(sessionQuery.data);

  const connectionsQuery = useStorageConnectionsQuery(hasStorageAccess);
  const routingRulesQuery = useStorageRoutingRulesQuery(hasStorageAccess);
  const categoriesQuery = useStorageCategoriesQuery(hasStorageAccess);

  const createMutation = useCreateStorageConnectionMutation();
  const updateMutation = useUpdateStorageConnectionMutation();
  const testMutation = useTestStorageConnectionMutation();
  const setDefaultMutation = useSetDefaultStorageConnectionMutation();
  const toggleStatusMutation = useToggleStorageConnectionStatusMutation();
  const upsertRuleMutation = useUpsertStorageRoutingRuleMutation();
  const clearRuleMutation = useClearCategoryRoutingRuleMutation();

  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);
  const [testingConnectionId, setTestingConnectionId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingConnection, setEditingConnection] = useState<StorageConnectionViewContract | null>(
    null,
  );
  const [formState, setFormState] = useState<ConnectionFormState>(() => createEmptyFormState());
  const [formError, setFormError] = useState<string | null>(null);

  const [pendingStatusToggle, setPendingStatusToggle] = useState<{
    readonly connection: StorageConnectionViewContract;
    readonly action: "activate" | "deactivate";
  } | null>(null);

  const [selectedRuleCategoryId, setSelectedRuleCategoryId] = useState("");
  const [selectedRuleConnectionId, setSelectedRuleConnectionId] = useState("");
  const [pendingRuleRemoval, setPendingRuleRemoval] = useState<{
    readonly categoryId: string;
    readonly categoryName: string;
  } | null>(null);

  const dialogTitleId = useId();

  const connections = connectionsQuery.data ?? [];
  const activeConnections = useMemo(
    () => connections.filter((conn) => conn.status === "ACTIVE"),
    [connections],
  );
  const categories = categoriesQuery.data ?? [];
  const routingRules = routingRulesQuery.data ?? [];

  const categoryById = useMemo(() => {
    const map = new Map<string, CategorySummaryRecord>();
    for (const category of categories) {
      map.set(category.id, category);
    }
    return map;
  }, [categories]);

  const connectionById = useMemo(() => {
    const map = new Map<string, StorageConnectionViewContract>();
    for (const connection of connections) {
      map.set(connection.id, connection);
    }
    return map;
  }, [connections]);

  const categoryRoutingRules = useMemo(
    () =>
      routingRules.filter(
        (rule): rule is StorageRoutingRuleViewContract & { readonly categoryId: string } =>
          rule.categoryId !== null,
      ),
    [routingRules],
  );

  if (sessionQuery.isLoading) {
    return <LoadingState message="Verificando permissões de armazenamento..." />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        title="Erro ao validar sessão"
        description={sessionQuery.error.message}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  if (!hasStorageAccess) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para gerenciar conexões de storage e regras de roteamento."
      />
    );
  }

  function handleOpenCreateDialog() {
    setEditingConnection(null);
    setFormState(createEmptyFormState("local"));
    setFormError(null);
    setDialogOpen(true);
  }

  function handleOpenEditDialog(connection: StorageConnectionViewContract) {
    if (connection.kind !== "local" && connection.kind !== "s3") {
      setFeedback({
        severity: "info",
        text: `O provedor "${connection.kind}" ainda não possui edição habilitada nesta interface.`,
      });
      return;
    }
    setEditingConnection(connection);
    setFormState(formStateFromConnection(connection));
    setFormError(null);
    setDialogOpen(true);
  }

  function handleCloseDialog() {
    if (createMutation.isPending || updateMutation.isPending) {
      return;
    }
    setDialogOpen(false);
    setEditingConnection(null);
    setFormError(null);
  }

  async function handleSubmitConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (editingConnection) {
      const built = validateAndBuildUpdatePayload(formState);
      if (!built.payload) {
        setFormError(built.error ?? "Revise os dados da conexão.");
        return;
      }
      try {
        const updated = await updateMutation.mutateAsync({
          connectionId: editingConnection.id,
          payload: built.payload,
        });
        setDialogOpen(false);
        setEditingConnection(null);
        setFeedback({
          severity: "success",
          text: `Conexão "${updated.name}" atualizada com sucesso.`,
        });
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : "Não foi possível atualizar a conexão.",
        );
      }
      return;
    }

    const built = validateAndBuildCreatePayload(formState);
    if (!built.payload) {
      setFormError(built.error ?? "Revise os dados da conexão.");
      return;
    }

    try {
      const created = await createMutation.mutateAsync(built.payload);
      setDialogOpen(false);
      setFeedback({
        severity: "success",
        text: `Conexão "${created.name}" cadastrada com sucesso.`,
      });
    } catch (error) {
      setFormError(
        error instanceof Error ? error.message : "Não foi possível cadastrar a conexão.",
      );
    }
  }

  async function handleTestHealth(connection: StorageConnectionViewContract) {
    setTestingConnectionId(connection.id);
    setFeedback(null);
    try {
      const result = await testMutation.mutateAsync(connection.id);
      setFeedback({
        severity: result.health.healthy ? "success" : "error",
        text: result.health.healthy
          ? `Saúde verificada em "${connection.name}": ${result.health.message}`
          : `Falha no teste de saúde de "${connection.name}": ${result.health.message}`,
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : "Falha ao testar saúde da conexão.",
      });
    } finally {
      setTestingConnectionId(null);
    }
  }

  async function handleSetDefault(connection: StorageConnectionViewContract) {
    setFeedback(null);
    try {
      const updated = await setDefaultMutation.mutateAsync(connection.id);
      setFeedback({
        severity: "success",
        text: `"${updated.name}" definida como destino padrão da organização.`,
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : "Não foi possível definir destino padrão.",
      });
    }
  }

  async function handleConfirmStatusToggle() {
    if (!pendingStatusToggle) {
      return;
    }
    const { connection, action } = pendingStatusToggle;
    setFeedback(null);
    try {
      const updated = await toggleStatusMutation.mutateAsync({
        connectionId: connection.id,
        action,
      });
      setPendingStatusToggle(null);
      setFeedback({
        severity: "success",
        text:
          action === "activate"
            ? `Conexão "${updated.name}" ativada.`
            : `Conexão "${updated.name}" desativada.`,
      });
    } catch (error) {
      setPendingStatusToggle(null);
      setFeedback({
        severity: "error",
        text:
          error instanceof Error ? error.message : "Não foi possível alterar o status da conexão.",
      });
    }
  }

  async function handleSaveRoutingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!selectedRuleCategoryId || !selectedRuleConnectionId) {
      setFeedback({
        severity: "error",
        text: "Selecione a categoria e a conexão de destino antes de salvar a regra.",
      });
      return;
    }

    try {
      await upsertRuleMutation.mutateAsync({
        categoryId: selectedRuleCategoryId,
        storageConnectionId: selectedRuleConnectionId,
      });
      const categoryName = categoryById.get(selectedRuleCategoryId)?.name ?? selectedRuleCategoryId;
      const connectionName =
        connectionById.get(selectedRuleConnectionId)?.name ?? selectedRuleConnectionId;
      setSelectedRuleCategoryId("");
      setSelectedRuleConnectionId("");
      setFeedback({
        severity: "success",
        text: `Regra salva: novos arquivos da categoria "${categoryName}" serão enviados para "${connectionName}".`,
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text:
          error instanceof Error ? error.message : "Não foi possível salvar a regra de roteamento.",
      });
    }
  }

  async function handleConfirmRuleRemoval() {
    if (!pendingRuleRemoval) {
      return;
    }
    const { categoryId, categoryName } = pendingRuleRemoval;
    setFeedback(null);
    try {
      await clearRuleMutation.mutateAsync(categoryId);
      setPendingRuleRemoval(null);
      setFeedback({
        severity: "success",
        text: `Regra específica da categoria "${categoryName}" removida. Novos envios seguirão o destino padrão.`,
      });
    } catch (error) {
      setPendingRuleRemoval(null);
      setFeedback({
        severity: "error",
        text:
          error instanceof Error
            ? error.message
            : "Não foi possível remover a regra de roteamento.",
      });
    }
  }

  const isDialogSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <StorageOutlinedIcon color="primary" fontSize="large" />
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Armazenamento e conexões
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Gerencie destinos locais e S3 compatíveis, teste a integridade das conexões e defina
              regras de roteamento por categoria.
            </Typography>
          </Box>
        </Stack>
        <Button
          variant="contained"
          startIcon={<AddOutlinedIcon />}
          onClick={handleOpenCreateDialog}
        >
          Nova conexão
        </Button>
      </Stack>

      {feedback ? (
        <Alert severity={feedback.severity} onClose={() => setFeedback(null)}>
          {feedback.text}
        </Alert>
      ) : null}

      <Paper
        variant="outlined"
        sx={{
          p: 3,
          borderRadius: 3,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
          backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={2}>
          <Box>
            <Typography variant="h6" fontWeight={600}>
              Conexões configuradas
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Credenciais armazenadas permanecem criptografadas no servidor e nunca são exibidas em
              texto plano.
            </Typography>
          </Box>

          {connectionsQuery.isLoading ? (
            <LoadingState message="Carregando conexões de armazenamento..." />
          ) : connectionsQuery.isError ? (
            <ErrorState
              title="Erro ao carregar conexões"
              description={connectionsQuery.error.message}
              onRetry={() => void connectionsQuery.refetch()}
            />
          ) : connections.length === 0 ? (
            <EmptyState
              title="Nenhuma conexão de storage cadastrada"
              description="Cadastre um diretório local ou bucket S3 compatível para habilitar o armazenamento de documentos."
              actionLabel="Nova conexão"
              onAction={handleOpenCreateDialog}
            />
          ) : (
            <TableContainer>
              <Table aria-label="Conexões de armazenamento">
                <TableHead>
                  <TableRow>
                    <TableCell>Conexão</TableCell>
                    <TableCell>Tipo</TableCell>
                    <TableCell>Destino e configuração</TableCell>
                    <TableCell>Credenciais</TableCell>
                    <TableCell>Status e saúde</TableCell>
                    <TableCell align="right">Ações</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {connections.map((connection) => {
                    const badge = CONNECTION_STATUS_BADGE[connection.status];
                    const isTestingThis =
                      testMutation.isPending && testingConnectionId === connection.id;
                    return (
                      <TableRow key={connection.id} hover>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2" fontWeight={600}>
                              {connection.name}
                            </Typography>
                            {connection.isDefault ? (
                              <Chip
                                label="Padrão"
                                size="small"
                                color="primary"
                                icon={<StarOutlineOutlinedIcon />}
                              />
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={CONNECTION_KIND_LABELS[connection.kind]}
                            size="small"
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {describeNonSecretTarget(connection)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {connection.kind === "local" ? (
                            <Typography variant="body2" color="text.secondary">
                              Não exigidas
                            </Typography>
                          ) : (
                            <Stack direction="row" spacing={0.75} alignItems="center">
                              <LockOutlinedIcon fontSize="small" color="action" />
                              <Typography variant="body2" color="text.secondary">
                                {connection.hasCredentials
                                  ? "•••••••• (criptografadas)"
                                  : "Não informadas"}
                              </Typography>
                            </Stack>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack spacing={0.5}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Chip label={badge.label} color={badge.color} size="small" />
                              <Typography variant="caption" color="text.secondary">
                                {formatDateTimePtBr(connection.lastHealthCheckAt)}
                              </Typography>
                            </Stack>
                            {connection.lastHealthMessage ? (
                              <Typography variant="caption" color="text.secondary">
                                {connection.lastHealthMessage}
                              </Typography>
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={1} justifyContent="flex-end">
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<HealthAndSafetyOutlinedIcon />}
                              disabled={isTestingThis}
                              onClick={() => void handleTestHealth(connection)}
                            >
                              {isTestingThis ? "Testando..." : "Testar saúde"}
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<EditOutlinedIcon />}
                              onClick={() => handleOpenEditDialog(connection)}
                            >
                              Editar
                            </Button>
                            {!connection.isDefault && connection.status === "ACTIVE" ? (
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={<CheckCircleOutlineOutlinedIcon />}
                                disabled={setDefaultMutation.isPending}
                                onClick={() => void handleSetDefault(connection)}
                              >
                                Definir como padrão
                              </Button>
                            ) : null}
                            <Button
                              size="small"
                              variant="text"
                              color={connection.status === "ACTIVE" ? "warning" : "primary"}
                              disabled={
                                toggleStatusMutation.isPending ||
                                (connection.status === "ACTIVE" && connection.isDefault)
                              }
                              onClick={() =>
                                setPendingStatusToggle({
                                  connection,
                                  action:
                                    connection.status === "ACTIVE" ? "deactivate" : "activate",
                                })
                              }
                            >
                              {connection.status === "ACTIVE" ? "Desativar" : "Ativar"}
                            </Button>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </Paper>

      <Paper
        variant="outlined"
        sx={{
          p: 3,
          borderRadius: 3,
          borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
          backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <RouteOutlinedIcon color="primary" />
            <Box>
              <Typography variant="h6" fontWeight={600}>
                Regras de roteamento por categoria
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Direcione novos uploads de uma categoria para uma conexão específica. Documentos
                enviados anteriormente permanecem em suas conexões originais.
              </Typography>
            </Box>
          </Stack>

          <Box component="form" onSubmit={handleSaveRoutingRule} noValidate>
            <Grid container spacing={2} alignItems="center">
              <Grid size={{ xs: 12, md: 5 }}>
                <TextField
                  select
                  fullWidth
                  label="Categoria de documento"
                  value={selectedRuleCategoryId}
                  onChange={(event) => setSelectedRuleCategoryId(event.target.value)}
                  disabled={categories.length === 0 || upsertRuleMutation.isPending}
                >
                  {categories.map((category) => (
                    <MenuItem key={category.id} value={category.id}>
                      {category.isActive ? category.name : `${category.name} (Inativa)`}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <TextField
                  select
                  fullWidth
                  label="Conexão de destino"
                  value={selectedRuleConnectionId}
                  onChange={(event) => setSelectedRuleConnectionId(event.target.value)}
                  disabled={activeConnections.length === 0 || upsertRuleMutation.isPending}
                >
                  {activeConnections.map((connection) => (
                    <MenuItem key={connection.id} value={connection.id}>
                      {connection.isDefault
                        ? `${connection.name} (Padrão)`
                        : `${connection.name} — ${CONNECTION_KIND_LABELS[connection.kind]}`}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, md: 2 }}>
                <Button
                  type="submit"
                  variant="contained"
                  fullWidth
                  disabled={
                    !selectedRuleCategoryId ||
                    !selectedRuleConnectionId ||
                    upsertRuleMutation.isPending
                  }
                >
                  {upsertRuleMutation.isPending ? "Salvando..." : "Salvar regra"}
                </Button>
              </Grid>
            </Grid>
          </Box>

          <Divider />

          {routingRulesQuery.isLoading ? (
            <LoadingState message="Carregando regras de roteamento..." />
          ) : routingRulesQuery.isError ? (
            <ErrorState
              title="Erro ao carregar regras"
              description={routingRulesQuery.error.message}
              onRetry={() => void routingRulesQuery.refetch()}
            />
          ) : categoryRoutingRules.length === 0 ? (
            <EmptyState
              title="Nenhuma regra específica por categoria"
              description="Todas as categorias utilizam atualmente a conexão padrão da organização."
            />
          ) : (
            <TableContainer>
              <Table aria-label="Regras de roteamento por categoria">
                <TableHead>
                  <TableRow>
                    <TableCell>Categoria</TableCell>
                    <TableCell>Conexão de destino</TableCell>
                    <TableCell>Atualizada em</TableCell>
                    <TableCell align="right">Ações</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {categoryRoutingRules.map((rule) => {
                    const category = categoryById.get(rule.categoryId);
                    const categoryName = category?.name ?? rule.categoryId;
                    const connection = connectionById.get(rule.storageConnectionId);
                    return (
                      <TableRow key={rule.id} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>
                            {categoryName}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">
                            {connection
                              ? `${connection.name} (${CONNECTION_KIND_LABELS[connection.kind]})`
                              : rule.storageConnectionId}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatDateTimePtBr(rule.updatedAt)}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            size="small"
                            color="error"
                            variant="text"
                            startIcon={<DeleteOutlineOutlinedIcon />}
                            disabled={clearRuleMutation.isPending}
                            onClick={() =>
                              setPendingRuleRemoval({
                                categoryId: rule.categoryId,
                                categoryName,
                              })
                            }
                          >
                            Remover regra
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Stack>
      </Paper>

      <Dialog
        open={dialogOpen}
        onClose={handleCloseDialog}
        aria-labelledby={dialogTitleId}
        maxWidth="md"
        fullWidth
      >
        <Box component="form" onSubmit={handleSubmitConnection} noValidate>
          <DialogTitle id={dialogTitleId}>
            {editingConnection
              ? `Editar conexão: ${editingConnection.name}`
              : "Nova conexão de storage"}
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2.5} sx={{ pt: 0.5 }}>
              {formError ? <Alert severity="error">{formError}</Alert> : null}

              {!editingConnection ? (
                <Tabs
                  value={formState.kind}
                  onChange={(_event, nextKind: EditableKind) => {
                    setFormError(null);
                    setFormState((prev) => ({ ...prev, kind: nextKind }));
                  }}
                  aria-label="Tipo de conexão de armazenamento"
                >
                  <Tab value="local" label="Armazenamento local" />
                  <Tab value="s3" label="S3 compatível" />
                </Tabs>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Tipo de provedor: <strong>{CONNECTION_KIND_LABELS[formState.kind]}</strong>
                </Typography>
              )}

              <TextField
                label="Nome da conexão"
                required
                fullWidth
                value={formState.name}
                onChange={(event) =>
                  setFormState((prev) => ({ ...prev, name: event.target.value }))
                }
                disabled={isDialogSaving}
              />

              {formState.kind === "local" ? (
                <Grid container spacing={2}>
                  <Grid size={{ xs: 12 }}>
                    <TextField
                      label="Diretório raiz absoluto"
                      required
                      fullWidth
                      placeholder="/var/lib/docuflow/storage"
                      helperText="Caminho absoluto dedicado ao repositório local (nunca a raiz '/')."
                      value={formState.rootDirectory}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, rootDirectory: event.target.value }))
                      }
                      disabled={isDialogSaving}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Tamanho máximo por objeto (bytes)"
                      type="number"
                      fullWidth
                      placeholder="104857600"
                      value={formState.maxObjectSizeBytes}
                      onChange={(event) =>
                        setFormState((prev) => ({
                          ...prev,
                          maxObjectSizeBytes: event.target.value,
                        }))
                      }
                      disabled={isDialogSaving}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label="Espaço livre mínimo (bytes)"
                      type="number"
                      fullWidth
                      placeholder="1073741824"
                      value={formState.minFreeBytes}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, minFreeBytes: event.target.value }))
                      }
                      disabled={isDialogSaving}
                    />
                  </Grid>
                </Grid>
              ) : (
                <Stack spacing={2}>
                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 6 }}>
                      <TextField
                        label="Endpoint S3"
                        required
                        fullWidth
                        placeholder="https://s3.exemplo.com"
                        value={formState.endpoint}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, endpoint: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <TextField
                        label="Região"
                        required
                        fullWidth
                        placeholder="us-east-1"
                        value={formState.region}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, region: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <TextField
                        label="Bucket"
                        required
                        fullWidth
                        placeholder="docuflow-docs"
                        value={formState.bucket}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, bucket: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Prefixo de chave (opcional)"
                        fullWidth
                        placeholder="producao/"
                        value={formState.keyPrefix}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, keyPrefix: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Timeout de conexão (ms)"
                        type="number"
                        fullWidth
                        value={formState.connectionTimeoutMs}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            connectionTimeoutMs: event.target.value,
                          }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Timeout de requisição (ms)"
                        type="number"
                        fullWidth
                        value={formState.requestTimeoutMs}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            requestTimeoutMs: event.target.value,
                          }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                  </Grid>

                  <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={formState.forcePathStyle}
                          onChange={(event) =>
                            setFormState((prev) => ({
                              ...prev,
                              forcePathStyle: event.target.checked,
                            }))
                          }
                          disabled={isDialogSaving}
                        />
                      }
                      label="Forçar path-style (MinIO)"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={formState.rejectUnauthorized}
                          onChange={(event) =>
                            setFormState((prev) => ({
                              ...prev,
                              rejectUnauthorized: event.target.checked,
                            }))
                          }
                          disabled={isDialogSaving}
                        />
                      }
                      label="Validar certificado TLS"
                    />
                    <FormControlLabel
                      control={
                        <Switch
                          checked={formState.allowInsecureHttp}
                          onChange={(event) =>
                            setFormState((prev) => ({
                              ...prev,
                              allowInsecureHttp: event.target.checked,
                            }))
                          }
                          disabled={isDialogSaving}
                        />
                      }
                      label="Permitir HTTP sem TLS"
                    />
                  </Stack>

                  <TextField
                    label="Certificado CA PEM (opcional)"
                    multiline
                    minRows={2}
                    fullWidth
                    value={formState.caCertificatePem}
                    onChange={(event) =>
                      setFormState((prev) => ({ ...prev, caCertificatePem: event.target.value }))
                    }
                    disabled={isDialogSaving}
                  />

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={600}>
                    Credenciais S3
                  </Typography>

                  {editingConnection?.hasCredentials ? (
                    <Alert severity="info">
                      Credenciais atuais criptografadas e ocultas (••••••••). Preencha os campos
                      abaixo somente se desejar rotacioná-las.
                    </Alert>
                  ) : null}

                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Access Key ID"
                        required={!editingConnection}
                        fullWidth
                        placeholder={editingConnection?.hasCredentials ? "••••••••" : ""}
                        inputProps={{ autoComplete: "off" }}
                        value={formState.accessKeyId}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, accessKeyId: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Secret Access Key"
                        type="password"
                        required={!editingConnection}
                        fullWidth
                        placeholder={editingConnection?.hasCredentials ? "••••••••" : ""}
                        inputProps={{ autoComplete: "new-password" }}
                        value={formState.secretAccessKey}
                        onChange={(event) =>
                          setFormState((prev) => ({
                            ...prev,
                            secretAccessKey: event.target.value,
                          }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label="Session Token (opcional)"
                        type="password"
                        fullWidth
                        placeholder={editingConnection?.hasCredentials ? "••••••••" : ""}
                        inputProps={{ autoComplete: "new-password" }}
                        value={formState.sessionToken}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, sessionToken: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {!editingConnection ? (
                <FormControlLabel
                  control={
                    <Switch
                      checked={formState.isDefault}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, isDefault: event.target.checked }))
                      }
                      disabled={isDialogSaving}
                    />
                  }
                  label="Definir como conexão padrão da organização"
                />
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 2 }}>
            <Button onClick={handleCloseDialog} disabled={isDialogSaving} variant="text">
              Cancelar
            </Button>
            <Button type="submit" disabled={isDialogSaving} variant="contained">
              {isDialogSaving
                ? "Salvando..."
                : editingConnection
                  ? "Salvar alterações"
                  : "Cadastrar conexão"}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <ConfirmDialog
        open={pendingStatusToggle !== null}
        title={
          pendingStatusToggle?.action === "deactivate" ? "Desativar conexão" : "Ativar conexão"
        }
        description={
          pendingStatusToggle?.action === "deactivate"
            ? `Deseja desativar a conexão "${pendingStatusToggle.connection.name}"? Novos uploads deixarão de utilizá-la.`
            : `Deseja reativar a conexão "${pendingStatusToggle?.connection.name ?? ""}"?`
        }
        confirmLabel={pendingStatusToggle?.action === "deactivate" ? "Desativar" : "Ativar"}
        confirmColor={pendingStatusToggle?.action === "deactivate" ? "warning" : "primary"}
        loading={toggleStatusMutation.isPending}
        onConfirm={() => void handleConfirmStatusToggle()}
        onCancel={() => setPendingStatusToggle(null)}
      />

      <ConfirmDialog
        open={pendingRuleRemoval !== null}
        title="Remover regra por categoria"
        description={`Remover a regra específica da categoria "${pendingRuleRemoval?.categoryName ?? ""}"? Novos uploads usarão a conexão padrão da organização.`}
        confirmLabel="Remover regra"
        confirmColor="error"
        loading={clearRuleMutation.isPending}
        onConfirm={() => void handleConfirmRuleRemoval()}
        onCancel={() => setPendingRuleRemoval(null)}
      />
    </Stack>
  );
}
