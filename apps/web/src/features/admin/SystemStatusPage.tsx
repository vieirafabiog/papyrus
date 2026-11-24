import type { OperationalDependencyStateContract } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import CheckCircleOutlineOutlinedIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import DnsOutlinedIcon from "@mui/icons-material/DnsOutlined";
import ErrorOutlineOutlinedIcon from "@mui/icons-material/ErrorOutlineOutlined";
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SettingsEthernetOutlinedIcon from "@mui/icons-material/SettingsEthernetOutlined";
import StarOutlineOutlinedIcon from "@mui/icons-material/StarOutlineOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import {
  Alert,
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { Link as RouterLink } from "react-router-dom";
import { useSessionQuery } from "../../app/session.js";
import { canViewSystemStatus, useSystemStatusQuery } from "./useSystemStatus.js";

const DEPENDENCY_BADGE: Readonly<
  Record<
    OperationalDependencyStateContract,
    {
      readonly label: string;
      readonly color: "success" | "error" | "warning";
    }
  >
> = {
  ok: { label: "Operacional", color: "success" },
  degraded: { label: "Degradado", color: "error" },
  unavailable: { label: "Indisponível", color: "warning" },
};

const STORAGE_STATUS_LABELS: Readonly<
  Record<
    string,
    {
      readonly label: string;
      readonly color: "success" | "default" | "error";
    }
  >
> = {
  ACTIVE: { label: "Ativa", color: "success" },
  INACTIVE: { label: "Inativa", color: "default" },
  ERROR: { label: "Com falha", color: "error" },
};

const STORAGE_KIND_LABELS: Readonly<Record<string, string>> = {
  local: "Armazenamento local",
  s3: "S3 compatível",
  azure_blob: "Azure Blob",
  google_cloud: "Google Cloud Storage",
};

function formatDateTimePtBr(isoValue: string | null): string {
  if (!isoValue) {
    return "Nunca verificada";
  }
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return isoValue;
  }
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function renderStatusIcon(state: OperationalDependencyStateContract) {
  if (state === "ok") {
    return <CheckCircleOutlineOutlinedIcon color="success" fontSize="small" />;
  }
  if (state === "degraded") {
    return <ErrorOutlineOutlinedIcon color="error" fontSize="small" />;
  }
  return <WarningAmberOutlinedIcon color="warning" fontSize="small" />;
}

/**
 * Administrative operational status page showing live verified health of PostgreSQL,
 * background worker, and configured storage connections along with last verification time.
 */
export function SystemStatusPage() {
  const sessionQuery = useSessionQuery();
  const hasStatusAccess = canViewSystemStatus(sessionQuery.data);
  const statusQuery = useSystemStatusQuery(hasStatusAccess);

  if (sessionQuery.isLoading) {
    return <LoadingState message="Verificando permissões operacionais..." />;
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

  if (!hasStatusAccess) {
    return (
      <ErrorState
        title="Acesso restrito"
        description="Você não possui permissão para consultar o status operacional da instalação."
      />
    );
  }

  if (statusQuery.isLoading) {
    return <LoadingState message="Consultando saúde do banco, worker e conexões de storage..." />;
  }

  if (statusQuery.isError) {
    return (
      <ErrorState
        title="Não foi possível consultar o status operacional"
        description={statusQuery.error.message}
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const report = statusQuery.data;
  if (!report) {
    return (
      <ErrorState
        title="Status operacional indisponível"
        description="Tente executar a verificação novamente."
        onRetry={() => void statusQuery.refetch()}
      />
    );
  }

  const componentsList = [
    {
      key: "database",
      icon: <DnsOutlinedIcon color="primary" />,
      data: report.components.database,
    },
    {
      key: "worker",
      icon: <SettingsEthernetOutlinedIcon color="primary" />,
      data: report.components.worker,
    },
  ] as const;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <MonitorHeartOutlinedIcon color="primary" fontSize="large" />
          <Box>
            <Typography variant="h4" fontWeight={700}>
              Status operacional
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Diagnóstico de saúde do banco de dados, worker de processamento e conexões de storage.
            </Typography>
          </Box>
        </Stack>

        <Button
          variant="contained"
          startIcon={<RefreshOutlinedIcon />}
          disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          {statusQuery.isFetching ? "Verificando..." : "Atualizar verificação"}
        </Button>
      </Stack>

      <Alert severity={report.overallStatus === "healthy" ? "success" : "warning"}>
        {report.overallStatus === "healthy"
          ? "Instalação operacional — banco de dados, worker e conexões verificadas sem falhas."
          : "Atenção operacional — ao menos um componente ou conexão de storage requer verificação."}{" "}
        Última verificação: <strong>{formatDateTimePtBr(report.checkedAt)}</strong>
      </Alert>

      <Grid container spacing={2}>
        {componentsList.map(({ key, icon, data }) => {
          const badge = DEPENDENCY_BADGE[data.status];
          return (
            <Grid key={key} size={{ xs: 12, md: 6 }}>
              <Paper
                variant="outlined"
                sx={{
                  p: 2.5,
                  height: "100%",
                  borderRadius: 3,
                  borderColor: DOCUFLOW_COLOR_TOKENS.surface.outlineVariant,
                  backgroundColor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
                }}
              >
                <Stack spacing={1.5}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Stack direction="row" spacing={1} alignItems="center">
                      {icon}
                      <Typography variant="subtitle1" fontWeight={600}>
                        {data.name}
                      </Typography>
                    </Stack>
                    <Chip
                      icon={renderStatusIcon(data.status)}
                      label={badge.label}
                      color={badge.color}
                      size="small"
                      variant="outlined"
                    />
                  </Stack>

                  <Typography variant="body2" color="text.secondary">
                    {data.message}
                  </Typography>

                  <Typography variant="caption" color="text.secondary">
                    Verificado em: {formatDateTimePtBr(data.checkedAt)}
                  </Typography>
                </Stack>
              </Paper>
            </Grid>
          );
        })}
      </Grid>

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
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems={{ xs: "flex-start", sm: "center" }}
            spacing={1}
          >
            <Stack direction="row" spacing={1} alignItems="center">
              <StorageOutlinedIcon color="primary" />
              <Box>
                <Typography variant="h6" fontWeight={600}>
                  Conexões de storage
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Estado registrado da última verificação de integridade de cada destino
                  configurado.
                </Typography>
              </Box>
            </Stack>

            <Button component={RouterLink} to="/admin/storage" size="small" variant="outlined">
              Gerenciar conexões
            </Button>
          </Stack>

          {report.storageConnections.length === 0 ? (
            <EmptyState
              title="Nenhuma conexão de storage cadastrada"
              description="Cadastre uma conexão local ou S3 compatível para acompanhar a saúde do repositório de arquivos."
            />
          ) : (
            <TableContainer>
              <Table aria-label="Status das conexões de storage">
                <TableHead>
                  <TableRow>
                    <TableCell>Conexão</TableCell>
                    <TableCell>Tipo</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell>Última verificação</TableCell>
                    <TableCell>Resultado</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {report.storageConnections.map((conn) => {
                    const statusBadge = STORAGE_STATUS_LABELS[conn.status] ?? {
                      label: conn.status,
                      color: "default" as const,
                    };
                    return (
                      <TableRow key={conn.id} hover>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <Typography variant="body2" fontWeight={600}>
                              {conn.name}
                            </Typography>
                            {conn.isDefault ? (
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
                            label={STORAGE_KIND_LABELS[conn.kind] ?? conn.kind}
                            size="small"
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Chip label={statusBadge.label} color={statusBadge.color} size="small" />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {formatDateTimePtBr(conn.lastHealthCheckAt)}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" color="text.secondary">
                            {conn.lastHealthMessage ?? "—"}
                          </Typography>
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
    </Stack>
  );
}
