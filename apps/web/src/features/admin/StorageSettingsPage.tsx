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
import type {
  CategorySummaryRecord,
  CreateStorageConnectionContract,
  StorageConnectionKindContract,
  StorageConnectionStatusContract,
  StorageConnectionViewContract,
  StorageRoutingRuleViewContract,
  UpdateStorageConnectionContract,
} from "@papyrus/contracts";
import {
  createStorageConnectionContractSchema,
  updateStorageConnectionContractSchema,
} from "@papyrus/contracts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorState,
  LoadingState,
  PAPYRUS_COLOR_TOKENS,
} from "@papyrus/ui";
import { type FormEvent, useId, useMemo, useState } from "react";
import { useSessionQuery } from "../../app/session.js";
import { type MessageKey, useI18n } from "../../i18n/index.js";
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

const CONNECTION_KIND_LABEL_KEYS: Readonly<Record<StorageConnectionKindContract, MessageKey>> = {
  local: "admin.storage.kind.local",
  s3: "admin.storage.kind.s3",
  azure_blob: "admin.storage.kind.azure_blob",
  google_cloud: "admin.storage.kind.google_cloud",
};

const CONNECTION_STATUS_BADGE_CONFIG: Readonly<
  Record<
    StorageConnectionStatusContract,
    { readonly labelKey: MessageKey; readonly color: "success" | "default" | "error" }
  >
> = {
  ACTIVE: { labelKey: "admin.storage.status.ACTIVE", color: "success" },
  INACTIVE: { labelKey: "admin.storage.status.INACTIVE", color: "default" },
  ERROR: { labelKey: "admin.storage.status.ERROR", color: "error" },
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

type TranslateFn = ReturnType<typeof useI18n>["t"];

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
    // Credentials are never returned by the backend; fields stay empty unless updated.
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

function describeNonSecretTarget(
  connection: StorageConnectionViewContract,
  t: TranslateFn,
): string {
  const config = connection.nonSecretConfig;
  if (connection.kind === "local") {
    const rootDirectory = readConfigString(config, "rootDirectory", "—");
    return t("admin.storage.target.local", { path: rootDirectory });
  }
  const bucket = readConfigString(config, "bucket", "—");
  const endpoint = readConfigString(config, "endpoint", "—");
  const region = readConfigString(config, "region", "—");
  const prefix = readConfigString(config, "keyPrefix");
  return prefix
    ? t("admin.storage.target.s3WithPrefix", { bucket, region, endpoint, prefix })
    : t("admin.storage.target.s3", { bucket, region, endpoint });
}

function validateAndBuildCreatePayload(
  form: ConnectionFormState,
  t: TranslateFn,
): {
  readonly payload?: CreateStorageConnectionContract;
  readonly error?: string;
} {
  if (form.kind === "local") {
    const maxObjectSizeBytes = parseOptionalInt(form.maxObjectSizeBytes);
    if (
      maxObjectSizeBytes !== undefined &&
      (Number.isNaN(maxObjectSizeBytes) || maxObjectSizeBytes <= 0)
    ) {
      return { error: t("admin.storage.validation.invalidMaxFileSize") };
    }
    const minFreeBytes = parseOptionalInt(form.minFreeBytes);
    if (minFreeBytes !== undefined && (Number.isNaN(minFreeBytes) || minFreeBytes < 0)) {
      return { error: t("admin.storage.validation.invalidMinFreeBytes") };
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
      return { error: t("admin.storage.validation.invalidLocalCreate") };
    }
    return { payload: parsed.data };
  }

  const connectionTimeoutMs = parseOptionalInt(form.connectionTimeoutMs) ?? 5_000;
  const requestTimeoutMs = parseOptionalInt(form.requestTimeoutMs) ?? 30_000;
  if (Number.isNaN(connectionTimeoutMs) || Number.isNaN(requestTimeoutMs)) {
    return { error: t("admin.storage.validation.invalidTimeouts") };
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
    return { error: t("admin.storage.validation.invalidS3Create") };
  }
  return { payload: parsed.data };
}

function validateAndBuildUpdatePayload(
  form: ConnectionFormState,
  t: TranslateFn,
): {
  readonly payload?: UpdateStorageConnectionContract;
  readonly error?: string;
} {
  if (form.kind === "local") {
    const maxObjectSizeBytes = parseOptionalInt(form.maxObjectSizeBytes);
    if (
      maxObjectSizeBytes !== undefined &&
      (Number.isNaN(maxObjectSizeBytes) || maxObjectSizeBytes <= 0)
    ) {
      return { error: t("admin.storage.validation.invalidMaxFileSize") };
    }
    const minFreeBytes = parseOptionalInt(form.minFreeBytes);
    if (minFreeBytes !== undefined && (Number.isNaN(minFreeBytes) || minFreeBytes < 0)) {
      return { error: t("admin.storage.validation.invalidMinFreeBytes") };
    }

    const parsed = updateStorageConnectionContractSchema.safeParse({
      name: form.name.trim(),
      rootDirectory: form.rootDirectory.trim(),
      ...(maxObjectSizeBytes !== undefined ? { maxObjectSizeBytes } : {}),
      ...(minFreeBytes !== undefined ? { minFreeBytes } : {}),
    });
    if (!parsed.success) {
      return { error: t("admin.storage.validation.invalidLocalUpdate") };
    }
    return { payload: parsed.data };
  }

  const hasAccessKey = form.accessKeyId.trim().length > 0;
  const hasSecretKey = form.secretAccessKey.length > 0;
  const hasSessionToken = form.sessionToken.trim().length > 0;
  if ((hasAccessKey || hasSecretKey || hasSessionToken) && !(hasAccessKey && hasSecretKey)) {
    return { error: t("admin.storage.validation.credentialsRequiredTogether") };
  }

  const connectionTimeoutMs = parseOptionalInt(form.connectionTimeoutMs) ?? 5_000;
  const requestTimeoutMs = parseOptionalInt(form.requestTimeoutMs) ?? 30_000;
  if (Number.isNaN(connectionTimeoutMs) || Number.isNaN(requestTimeoutMs)) {
    return { error: t("admin.storage.validation.invalidTimeouts") };
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
    return { error: t("admin.storage.validation.invalidS3Update") };
  }
  return { payload: parsed.data };
}

/**
 * Administrative page for managing local and S3 storage connections, health checks,
 * default destination selection, masked credential updates, and category routing rules.
 */
export function StorageSettingsPage() {
  const { t, formatDateTime } = useI18n();
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
    return <LoadingState message={t("admin.storage.loadingPermissions")} />;
  }

  if (sessionQuery.isError) {
    return (
      <ErrorState
        title={t("admin.common.sessionErrorTitle")}
        description={sessionQuery.error.message}
        onRetry={() => void sessionQuery.refetch()}
      />
    );
  }

  if (!hasStorageAccess) {
    return (
      <ErrorState
        title={t("admin.common.restrictedAccessTitle")}
        description={t("admin.storage.noAccessDescription")}
      />
    );
  }

  function formatHealthTimestamp(value: string | null): string {
    return formatDateTime(value, t("admin.common.neverChecked"));
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
        text: t("admin.storage.feedback.providerNotEditable", { kind: connection.kind }),
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
      const built = validateAndBuildUpdatePayload(formState, t);
      if (!built.payload) {
        setFormError(built.error ?? t("admin.storage.validation.reviewConnectionData"));
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
          text: t("admin.storage.feedback.updated", { name: updated.name }),
        });
      } catch (error) {
        setFormError(
          error instanceof Error ? error.message : t("admin.storage.errors.updateFailed"),
        );
      }
      return;
    }

    const built = validateAndBuildCreatePayload(formState, t);
    if (!built.payload) {
      setFormError(built.error ?? t("admin.storage.validation.reviewConnectionData"));
      return;
    }

    try {
      const created = await createMutation.mutateAsync(built.payload);
      setDialogOpen(false);
      setFeedback({
        severity: "success",
        text: t("admin.storage.feedback.created", { name: created.name }),
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("admin.storage.errors.createFailed"));
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
          ? t("admin.storage.feedback.healthOk", {
              name: connection.name,
              message: result.health.message,
            })
          : t("admin.storage.feedback.healthFailed", {
              name: connection.name,
              message: result.health.message,
            }),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : t("admin.storage.errors.testFailed"),
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
        text: t("admin.storage.feedback.defaultSet", { name: updated.name }),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : t("admin.storage.errors.setDefaultFailed"),
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
            ? t("admin.storage.feedback.activated", { name: updated.name })
            : t("admin.storage.feedback.deactivated", { name: updated.name }),
      });
    } catch (error) {
      setPendingStatusToggle(null);
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : t("admin.storage.errors.toggleStatusFailed"),
      });
    }
  }

  async function handleSaveRoutingRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!selectedRuleCategoryId || !selectedRuleConnectionId) {
      setFeedback({
        severity: "error",
        text: t("admin.storage.validation.selectCategoryAndConnection"),
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
        text: t("admin.storage.feedback.ruleSaved", {
          category: categoryName,
          connection: connectionName,
        }),
      });
    } catch (error) {
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : t("admin.storage.errors.saveRuleFailed"),
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
        text: t("admin.storage.feedback.ruleRemoved", { category: categoryName }),
      });
    } catch (error) {
      setPendingRuleRemoval(null);
      setFeedback({
        severity: "error",
        text: error instanceof Error ? error.message : t("admin.storage.errors.removeRuleFailed"),
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
            <Typography variant="h1" component="h1">
              {t("admin.storage.title")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("admin.storage.subtitle")}
            </Typography>
          </Box>
        </Stack>
        <Button
          variant="contained"
          startIcon={<AddOutlinedIcon />}
          onClick={handleOpenCreateDialog}
        >
          {t("admin.storage.actions.newConnection")}
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
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
          backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={2}>
          <Box>
            <Typography variant="h2" component="h2" fontWeight={600}>
              {t("admin.storage.connectionsTitle")}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t("admin.storage.connectionsSubtitle")}
            </Typography>
          </Box>

          {connectionsQuery.isLoading ? (
            <LoadingState message={t("admin.storage.loadingConnections")} />
          ) : connectionsQuery.isError ? (
            <ErrorState
              title={t("admin.storage.loadConnectionsErrorTitle")}
              description={connectionsQuery.error.message}
              onRetry={() => void connectionsQuery.refetch()}
            />
          ) : connections.length === 0 ? (
            <EmptyState
              title={t("admin.storage.emptyConnectionsTitle")}
              description={t("admin.storage.emptyConnectionsDescription")}
              actionLabel={t("admin.storage.actions.newConnection")}
              onAction={handleOpenCreateDialog}
            />
          ) : (
            <TableContainer>
              <Table aria-label={t("admin.storage.tableAria")}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("admin.storage.colConnection")}</TableCell>
                    <TableCell>{t("admin.storage.colType")}</TableCell>
                    <TableCell>{t("admin.storage.colTarget")}</TableCell>
                    <TableCell>{t("admin.storage.colCredentials")}</TableCell>
                    <TableCell>{t("admin.storage.colStatusHealth")}</TableCell>
                    <TableCell align="right">{t("admin.common.actions")}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {connections.map((connection) => {
                    const badge = CONNECTION_STATUS_BADGE_CONFIG[connection.status];
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
                                label={t("admin.common.defaultBadge")}
                                size="small"
                                color="primary"
                                icon={<StarOutlineOutlinedIcon />}
                              />
                            ) : null}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={t(CONNECTION_KIND_LABEL_KEYS[connection.kind])}
                            size="small"
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {describeNonSecretTarget(connection, t)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          {connection.kind === "local" ? (
                            <Typography variant="body2" color="text.secondary">
                              {t("admin.storage.credentialsNotRequired")}
                            </Typography>
                          ) : (
                            <Stack direction="row" spacing={0.75} alignItems="center">
                              <LockOutlinedIcon fontSize="small" color="action" />
                              <Typography variant="body2" color="text.secondary">
                                {connection.hasCredentials
                                  ? t("admin.storage.credentialsEncrypted")
                                  : t("admin.storage.credentialsMissing")}
                              </Typography>
                            </Stack>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack spacing={0.5}>
                            <Stack direction="row" spacing={1} alignItems="center">
                              <Chip label={t(badge.labelKey)} color={badge.color} size="small" />
                              <Typography variant="caption" color="text.secondary">
                                {formatHealthTimestamp(connection.lastHealthCheckAt)}
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
                              {isTestingThis
                                ? t("admin.storage.actions.testingHealth")
                                : t("admin.storage.actions.testHealth")}
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<EditOutlinedIcon />}
                              onClick={() => handleOpenEditDialog(connection)}
                            >
                              {t("admin.common.edit")}
                            </Button>
                            {!connection.isDefault && connection.status === "ACTIVE" ? (
                              <Button
                                size="small"
                                variant="outlined"
                                startIcon={<CheckCircleOutlineOutlinedIcon />}
                                disabled={setDefaultMutation.isPending}
                                onClick={() => void handleSetDefault(connection)}
                              >
                                {t("admin.storage.actions.setDefault")}
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
                              {connection.status === "ACTIVE"
                                ? t("admin.common.deactivate")
                                : t("admin.common.activate")}
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
          borderColor: PAPYRUS_COLOR_TOKENS.surface.outlineVariant,
          backgroundColor: PAPYRUS_COLOR_TOKENS.surface.containerLowest,
        }}
      >
        <Stack spacing={2.5}>
          <Stack direction="row" spacing={1.25} alignItems="center">
            <RouteOutlinedIcon color="primary" />
            <Box>
              <Typography variant="h2" component="h2" fontWeight={600}>
                {t("admin.storage.routing.title")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("admin.storage.routing.subtitle")}
              </Typography>
            </Box>
          </Stack>

          <Box component="form" onSubmit={handleSaveRoutingRule} noValidate>
            <Grid container spacing={2} alignItems="center">
              <Grid size={{ xs: 12, md: 5 }}>
                <TextField
                  select
                  fullWidth
                  label={t("admin.storage.routing.categoryLabel")}
                  value={selectedRuleCategoryId}
                  onChange={(event) => setSelectedRuleCategoryId(event.target.value)}
                  disabled={categories.length === 0 || upsertRuleMutation.isPending}
                >
                  {categories.map((category) => (
                    <MenuItem key={category.id} value={category.id}>
                      {category.isActive
                        ? category.name
                        : t("admin.storage.routing.inactiveSuffix", { name: category.name })}
                    </MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <TextField
                  select
                  fullWidth
                  label={t("admin.storage.routing.connectionLabel")}
                  value={selectedRuleConnectionId}
                  onChange={(event) => setSelectedRuleConnectionId(event.target.value)}
                  disabled={activeConnections.length === 0 || upsertRuleMutation.isPending}
                >
                  {activeConnections.map((connection) => (
                    <MenuItem key={connection.id} value={connection.id}>
                      {connection.isDefault
                        ? t("admin.storage.routing.defaultSuffix", { name: connection.name })
                        : `${connection.name} — ${t(CONNECTION_KIND_LABEL_KEYS[connection.kind])}`}
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
                  {upsertRuleMutation.isPending
                    ? t("admin.common.saving")
                    : t("admin.storage.routing.saveRule")}
                </Button>
              </Grid>
            </Grid>
          </Box>

          <Divider />

          {routingRulesQuery.isLoading ? (
            <LoadingState message={t("admin.storage.routing.loadingRules")} />
          ) : routingRulesQuery.isError ? (
            <ErrorState
              title={t("admin.storage.routing.loadRulesErrorTitle")}
              description={routingRulesQuery.error.message}
              onRetry={() => void routingRulesQuery.refetch()}
            />
          ) : categoryRoutingRules.length === 0 ? (
            <EmptyState
              title={t("admin.storage.routing.emptyTitle")}
              description={t("admin.storage.routing.emptyDescription")}
            />
          ) : (
            <TableContainer>
              <Table aria-label={t("admin.storage.routing.tableAria")}>
                <TableHead>
                  <TableRow>
                    <TableCell>{t("admin.storage.routing.colCategory")}</TableCell>
                    <TableCell>{t("admin.storage.routing.colDestination")}</TableCell>
                    <TableCell>{t("admin.common.updatedAt")}</TableCell>
                    <TableCell align="right">{t("admin.common.actions")}</TableCell>
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
                              ? `${connection.name} (${t(CONNECTION_KIND_LABEL_KEYS[connection.kind])})`
                              : rule.storageConnectionId}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatDateTime(rule.updatedAt)}
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
                            {t("admin.storage.routing.removeRule")}
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
              ? t("admin.storage.dialog.editTitle", { name: editingConnection.name })
              : t("admin.storage.dialog.newTitle")}
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
                  aria-label={t("admin.storage.dialog.kindTabsAria")}
                >
                  <Tab value="local" label={t("admin.storage.kind.local")} />
                  <Tab value="s3" label={t("admin.storage.kind.s3")} />
                </Tabs>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  {t("admin.storage.dialog.providerType")}{" "}
                  <strong>{t(CONNECTION_KIND_LABEL_KEYS[formState.kind])}</strong>
                </Typography>
              )}

              <TextField
                label={t("admin.storage.dialog.name")}
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
                      label={t("admin.storage.dialog.folderPath")}
                      required
                      fullWidth
                      placeholder={t("admin.storage.dialog.folderPathPlaceholder")}
                      helperText={t("admin.storage.dialog.folderPathHelper")}
                      value={formState.rootDirectory}
                      onChange={(event) =>
                        setFormState((prev) => ({ ...prev, rootDirectory: event.target.value }))
                      }
                      disabled={isDialogSaving}
                    />
                  </Grid>
                  <Grid size={{ xs: 12, sm: 6 }}>
                    <TextField
                      label={t("admin.storage.dialog.maxFileSizeBytes")}
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
                      label={t("admin.storage.dialog.minFreeBytes")}
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
                        label={t("admin.storage.dialog.endpoint")}
                        required
                        fullWidth
                        placeholder="https://s3.example.com"
                        value={formState.endpoint}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, endpoint: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 3 }}>
                      <TextField
                        label={t("admin.storage.dialog.region")}
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
                        label={t("admin.storage.dialog.bucket")}
                        required
                        fullWidth
                        placeholder="papyrus-docs"
                        value={formState.bucket}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, bucket: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label={t("admin.storage.dialog.keyPrefix")}
                        fullWidth
                        placeholder={t("admin.storage.dialog.keyPrefixPlaceholder")}
                        value={formState.keyPrefix}
                        onChange={(event) =>
                          setFormState((prev) => ({ ...prev, keyPrefix: event.target.value }))
                        }
                        disabled={isDialogSaving}
                      />
                    </Grid>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label={t("admin.storage.dialog.connectionTimeoutMs")}
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
                        label={t("admin.storage.dialog.requestTimeoutMs")}
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
                      label={t("admin.storage.dialog.forcePathStyle")}
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
                      label={t("admin.storage.dialog.verifyCertificate")}
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
                      label={t("admin.storage.dialog.allowUnencryptedHttp")}
                    />
                  </Stack>

                  <TextField
                    label={t("admin.storage.dialog.caCertificatePem")}
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
                    {t("admin.storage.dialog.credentialsTitle")}
                  </Typography>

                  {editingConnection?.hasCredentials ? (
                    <Alert severity="info">
                      {t("admin.storage.dialog.updateCredentialsNotice")}
                    </Alert>
                  ) : null}

                  <Grid container spacing={2}>
                    <Grid size={{ xs: 12, sm: 4 }}>
                      <TextField
                        label={t("admin.storage.dialog.accessKeyId")}
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
                        label={t("admin.storage.dialog.secretAccessKey")}
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
                        label={t("admin.storage.dialog.sessionToken")}
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
                  label={t("admin.storage.dialog.setDefaultSwitch")}
                />
              ) : null}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3, py: 2 }}>
            <Button onClick={handleCloseDialog} disabled={isDialogSaving} variant="text">
              {t("admin.common.cancel")}
            </Button>
            <Button type="submit" disabled={isDialogSaving} variant="contained">
              {isDialogSaving
                ? t("admin.common.saving")
                : editingConnection
                  ? t("admin.common.saveChanges")
                  : t("admin.storage.dialog.createSubmit")}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <ConfirmDialog
        open={pendingStatusToggle !== null}
        title={
          pendingStatusToggle?.action === "deactivate"
            ? t("admin.storage.confirmToggle.deactivateTitle")
            : t("admin.storage.confirmToggle.activateTitle")
        }
        description={
          pendingStatusToggle?.action === "deactivate"
            ? t("admin.storage.confirmToggle.deactivateDescription", {
                name: pendingStatusToggle.connection.name,
              })
            : t("admin.storage.confirmToggle.activateDescription", {
                name: pendingStatusToggle?.connection.name ?? "",
              })
        }
        confirmLabel={
          pendingStatusToggle?.action === "deactivate"
            ? t("admin.common.deactivate")
            : t("admin.common.activate")
        }
        confirmColor={pendingStatusToggle?.action === "deactivate" ? "warning" : "primary"}
        loading={toggleStatusMutation.isPending}
        onConfirm={() => void handleConfirmStatusToggle()}
        onCancel={() => setPendingStatusToggle(null)}
      />

      <ConfirmDialog
        open={pendingRuleRemoval !== null}
        title={t("admin.storage.confirmRemoveRule.title")}
        description={t("admin.storage.confirmRemoveRule.description", {
          categoryName: pendingRuleRemoval?.categoryName ?? "",
        })}
        confirmLabel={t("admin.storage.routing.removeRule")}
        confirmColor="error"
        loading={clearRuleMutation.isPending}
        onConfirm={() => void handleConfirmRuleRemoval()}
        onCancel={() => setPendingRuleRemoval(null)}
      />
    </Stack>
  );
}
