import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SecurityOutlinedIcon from "@mui/icons-material/SecurityOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import {
  Box,
  Button,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useDashboardSummary } from "./useDashboardSummary.js";

interface KpiCardProps {
  readonly label: string;
  readonly value: string | number;
  readonly subtitle?: string | undefined;
  readonly icon: ReactNode;
}

const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR");
const BYTE_NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR", {
  maximumFractionDigits: 1,
});

function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${NUMBER_FORMATTER.format(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${BYTE_NUMBER_FORMATTER.format(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${BYTE_NUMBER_FORMATTER.format(mb)} MB`;
  }
  const gb = mb / 1024;
  return `${BYTE_NUMBER_FORMATTER.format(gb)} GB`;
}

function KpiSummaryItem({ label, value, subtitle, icon }: KpiCardProps) {
  return (
    <Paper
      sx={{
        p: 2.5,
        flex: "1 1 200px",
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} mb={1}>
        <Typography variant="body2" color="text.secondary">
          {label}
        </Typography>
        <Box sx={{ color: "text.secondary", display: "flex", alignItems: "center" }}>{icon}</Box>
      </Stack>
      <Typography variant="h2" component="p" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Typography>
      {subtitle ? (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {subtitle}
        </Typography>
      ) : null}
    </Paper>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isPending, isFetching, isError, error, refetch } = useDashboardSummary();

  const hasNoSummaryData =
    data === null ||
    (data !== undefined &&
      data.totalDocuments === 0 &&
      data.pendingTasks === 0 &&
      data.expiringSoonDocuments === 0 &&
      data.quarantinedFiles === 0 &&
      data.storageUsedBytes === 0 &&
      data.storageFileCount === 0 &&
      data.recentActivity.length === 0);

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", sm: "center" }}
        spacing={2}
      >
        <Box>
          <Typography variant="h1" gutterBottom>
            Visão geral
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Resumo operacional e indicadores reais do repositório documental.
          </Typography>
        </Box>
        {data !== undefined && data !== null ? (
          <Stack direction="row" spacing={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<RefreshOutlinedIcon />}
              disabled={isFetching}
              onClick={() => void refetch()}
            >
              {isFetching ? "Atualizando..." : "Atualizar"}
            </Button>
            <Button variant="contained" size="small" onClick={() => navigate("/documentos")}>
              Ver documentos
            </Button>
          </Stack>
        ) : null}
      </Stack>

      {isPending ? (
        <LoadingState message="Carregando resumo do acervo..." />
      ) : isError ? (
        <ErrorState description={error.message} onRetry={() => void refetch()} />
      ) : hasNoSummaryData ? (
        <EmptyState
          title="Nenhum resumo disponível no momento"
          description="Os indicadores serão exibidos assim que houver documentos ou atividades autorizadas no seu escopo."
          actionLabel="Ir para documentos"
          onAction={() => navigate("/documentos")}
        />
      ) : data ? (
        <Stack spacing={3}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
            <KpiSummaryItem
              label="Total de documentos"
              value={data.totalDocuments}
              icon={<DescriptionOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label="Tarefas pendentes"
              value={data.pendingTasks}
              icon={<PendingActionsOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label="Vencimentos próximos"
              value={data.expiringSoonDocuments}
              subtitle="Próximos 30 dias"
              icon={<EventBusyOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label="Arquivos em análise"
              value={data.quarantinedFiles}
              icon={<SecurityOutlinedIcon fontSize="small" />}
            />
            <KpiSummaryItem
              label="Armazenamento utilizado"
              value={formatStorageBytes(data.storageUsedBytes)}
              subtitle={`${NUMBER_FORMATTER.format(data.storageFileCount)} ${
                data.storageFileCount === 1 ? "arquivo ativo" : "arquivos ativos"
              }`}
              icon={<StorageOutlinedIcon fontSize="small" />}
            />
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
            <Typography variant="h3" component="h2" gutterBottom>
              Atividade recente
            </Typography>
            {data.recentActivity.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nenhuma atividade recente registrada.
              </Typography>
            ) : (
              <List dense disablePadding>
                {data.recentActivity.map((item) => {
                  const isNavigableDoc =
                    item.resourceType === "DOCUMENT" && item.resourceId !== null;
                  const occurredLabel = new Date(item.occurredAt).toLocaleString("pt-BR");
                  const titleLabel = `${item.action} — ${item.resourceType}`;

                  if (isNavigableDoc && item.resourceId) {
                    const targetId = item.resourceId;
                    return (
                      <ListItem key={item.id} divider disablePadding>
                        <ListItemButton onClick={() => navigate(`/documentos/${targetId}`)}>
                          <ListItemText primary={titleLabel} secondary={occurredLabel} />
                        </ListItemButton>
                      </ListItem>
                    );
                  }

                  return (
                    <ListItem key={item.id} divider disableGutters>
                      <ListItemText primary={titleLabel} secondary={occurredLabel} />
                    </ListItem>
                  );
                })}
              </List>
            )}
          </Paper>
        </Stack>
      ) : null}
    </Stack>
  );
}
