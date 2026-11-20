import {
  DOCUFLOW_COLOR_TOKENS,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@docuflow/ui";
import {
  Box,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Typography,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import { useDashboardSummary } from "./useDashboardSummary.js";

interface KpiCardProps {
  readonly label: string;
  readonly value: number;
}

function KpiSummaryItem({ label, value }: KpiCardProps) {
  return (
    <Paper
      sx={{
        p: 2.5,
        flex: "1 1 200px",
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Typography variant="body2" color="text.secondary" gutterBottom>
        {label}
      </Typography>
      <Typography variant="h2" component="p" sx={{ fontVariantNumeric: "tabular-nums" }}>
        {value}
      </Typography>
    </Paper>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const { data, isPending, isError, error, refetch } = useDashboardSummary();

  const hasNoSummaryData =
    data === null ||
    (data !== undefined &&
      data.totalDocuments === 0 &&
      data.pendingTasks === 0 &&
      data.expiringSoonDocuments === 0 &&
      data.quarantinedFiles === 0 &&
      data.recentActivity.length === 0);

  return (
    <Stack spacing={3}>
      <Box>
        <Typography variant="h1" gutterBottom>
          Visão geral
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Resumo operacional do repositório documental.
        </Typography>
      </Box>

      {isPending ? (
        <LoadingState message="Carregando resumo do acervo..." />
      ) : isError ? (
        <ErrorState
          description={error.message}
          onRetry={() => void refetch()}
        />
      ) : hasNoSummaryData ? (
        <EmptyState
          title="Nenhum resumo disponível no momento"
          description="Os indicadores serão exibidos assim que o endpoint de resumo e os primeiros documentos estiverem disponíveis."
          actionLabel="Ir para documentos"
          onAction={() => navigate("/documentos")}
        />
      ) : data ? (
        <Stack spacing={3}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
            <KpiSummaryItem label="Total de documentos" value={data.totalDocuments} />
            <KpiSummaryItem label="Tarefas pendentes" value={data.pendingTasks} />
            <KpiSummaryItem label="Vencimentos próximos" value={data.expiringSoonDocuments} />
            <KpiSummaryItem label="Arquivos em análise" value={data.quarantinedFiles} />
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
                {data.recentActivity.map((item) => (
                  <ListItem key={item.id} divider disableGutters>
                    <ListItemText
                      primary={`${item.action} — ${item.resourceType}`}
                      secondary={new Date(item.occurredAt).toLocaleString("pt-BR")}
                    />
                  </ListItem>
                ))}
              </List>
            )}
          </Paper>
        </Stack>
      ) : null}
    </Stack>
  );
}
