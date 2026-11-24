import type { DocumentStatus } from "@docuflow/contracts";
import { DOCUFLOW_COLOR_TOKENS, EmptyState, ErrorState, LoadingState } from "@docuflow/ui";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import DownloadOutlinedIcon from "@mui/icons-material/DownloadOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import PendingActionsOutlinedIcon from "@mui/icons-material/PendingActionsOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import {
  Box,
  Button,
  Chip,
  LinearProgress,
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
import type { ReactNode } from "react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDocumentListCategoriesQuery } from "../documents/useDocumentList.js";
import {
  DEFAULT_REPOSITORY_REPORT_FILTERS,
  type RepositoryReportFilters,
  buildRepositoryReportCsvUrl,
  useRepositoryReportQuery,
} from "./useRepositoryReport.js";

const NUMBER_FORMATTER = new Intl.NumberFormat("pt-BR");
const DECIMAL_FORMATTER = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

const DOCUMENT_STATUS_META: Readonly<
  Record<
    DocumentStatus,
    { readonly label: string; readonly color: "default" | "info" | "success" | "warning" | "error" }
  >
> = {
  DRAFT: { label: "Rascunho", color: "default" },
  IN_REVIEW: { label: "Em revisão", color: "info" },
  APPROVED: { label: "Aprovado", color: "success" },
  REJECTED: { label: "Rejeitado", color: "error" },
  ARCHIVED: { label: "Arquivado", color: "default" },
  EXPIRED: { label: "Expirado", color: "warning" },
  DELETED: { label: "Excluído", color: "error" },
};

const STORAGE_KIND_LABELS: Readonly<Record<string, string>> = {
  local: "Filesystem local",
  s3: "S3 compatível",
  azure_blob: "Azure Blob",
  google_cloud: "Google Cloud Storage",
};

const WINDOW_OPTIONS = [7, 15, 30, 60, 90] as const;

function formatBytesPtBr(bytes: number): string {
  if (bytes < 1024) {
    return `${NUMBER_FORMATTER.format(bytes)} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${DECIMAL_FORMATTER.format(kb)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${DECIMAL_FORMATTER.format(mb)} MB`;
  }
  const gb = mb / 1024;
  return `${DECIMAL_FORMATTER.format(gb)} GB`;
}

function MetricSummaryCard({
  label,
  value,
  subtitle,
  icon,
}: {
  readonly label: string;
  readonly value: string | number;
  readonly subtitle?: string | undefined;
  readonly icon: ReactNode;
}) {
  return (
    <Paper
      sx={{
        p: 2.25,
        flex: "1 1 190px",
        bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest,
      }}
    >
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
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

/**
 * Consolidated repository reporting page (`/reports`) powered by server-side
 * PostgreSQL aggregations scoped strictly to the user's authorized documents.
 */
export function ReportsPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<RepositoryReportFilters>(
    DEFAULT_REPOSITORY_REPORT_FILTERS,
  );

  const categoriesQuery = useDocumentListCategoriesQuery();
  const reportQuery = useRepositoryReportQuery(filters);

  const categories = categoriesQuery.data ?? [];
  const report = reportQuery.data;

  const hasCustomFilter =
    filters.categoryId.length > 0 ||
    filters.status.length > 0 ||
    filters.expirationWindowDays !== DEFAULT_REPOSITORY_REPORT_FILTERS.expirationWindowDays;

  const csvExportUrl = buildRepositoryReportCsvUrl(filters);

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
            Relatórios
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Totais por categoria, status, vencimentos e espaço utilizado no seu escopo autorizado.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={reportQuery.isFetching}
            onClick={() => void reportQuery.refetch()}
          >
            {reportQuery.isFetching ? "Atualizando..." : "Atualizar"}
          </Button>
          <Button
            component="a"
            href={csvExportUrl}
            download="docuflow-relatorio-acervo.csv"
            variant="contained"
            size="small"
            startIcon={<DownloadOutlinedIcon />}
            disabled={reportQuery.isLoading || reportQuery.isError}
          >
            Exportar CSV
          </Button>
        </Stack>
      </Stack>

      <Paper sx={{ p: 2, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
        <Stack
          direction={{ xs: "column", sm: "row" }}
          spacing={2}
          alignItems={{ xs: "stretch", sm: "center" }}
          flexWrap="wrap"
        >
          <TextField
            select
            size="small"
            label="Janela de vencimento"
            value={filters.expirationWindowDays}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                expirationWindowDays: Number(event.target.value),
              }))
            }
            sx={{ minWidth: 190 }}
          >
            {WINDOW_OPTIONS.map((days) => (
              <MenuItem key={days} value={days}>
                Próximos {days} dias
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label="Categoria"
            value={filters.categoryId}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, categoryId: event.target.value }))
            }
            sx={{ minWidth: 210 }}
          >
            <MenuItem value="">Todas as categorias</MenuItem>
            {categories.map((cat) => (
              <MenuItem key={cat.id} value={cat.id}>
                {cat.name}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            select
            size="small"
            label="Status"
            value={filters.status}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, status: event.target.value as DocumentStatus | "" }))
            }
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">Todos os status ativos</MenuItem>
            {(["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "ARCHIVED", "EXPIRED"] as const).map(
              (statusKey) => (
                <MenuItem key={statusKey} value={statusKey}>
                  {DOCUMENT_STATUS_META[statusKey].label}
                </MenuItem>
              ),
            )}
          </TextField>

          {hasCustomFilter ? (
            <Button
              size="small"
              color="inherit"
              onClick={() => setFilters(DEFAULT_REPOSITORY_REPORT_FILTERS)}
            >
              Limpar filtros
            </Button>
          ) : null}
        </Stack>
      </Paper>

      {reportQuery.isLoading ? (
        <LoadingState message="Calculando indicadores consolidados no PostgreSQL..." />
      ) : reportQuery.isError ? (
        <ErrorState
          description={reportQuery.error.message}
          onRetry={() => void reportQuery.refetch()}
        />
      ) : !report || (report.totals.totalDocuments === 0 && !hasCustomFilter) ? (
        <EmptyState
          title="Nenhum documento encontrado para relatório"
          description="Envie documentos ao repositório para visualizar a distribuição por categoria, status, vencimentos e uso de armazenamento."
          actionLabel="Ir para documentos"
          onAction={() => void navigate("/documents")}
        />
      ) : (
        <Stack spacing={2.5}>
          <Box sx={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
            <MetricSummaryCard
              label="Total de documentos"
              value={NUMBER_FORMATTER.format(report.totals.totalDocuments)}
              icon={<DescriptionOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label="Versões armazenadas"
              value={NUMBER_FORMATTER.format(report.totals.totalVersions)}
              subtitle={`${NUMBER_FORMATTER.format(report.totals.totalActiveFiles)} arquivo(s) ativo(s)`}
              icon={<LayersOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label="Espaço utilizado"
              value={formatBytesPtBr(report.totals.storageUsedBytes)}
              subtitle={`${NUMBER_FORMATTER.format(report.totals.quarantinedFiles)} em análise`}
              icon={<StorageOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label="Vencidos / Próximos"
              value={`${NUMBER_FORMATTER.format(report.expirations.expired)} / ${NUMBER_FORMATTER.format(report.expirations.expiringSoon)}`}
              subtitle={`Janela de ${report.expirations.windowDays} dias`}
              icon={<EventBusyOutlinedIcon fontSize="small" />}
            />
            <MetricSummaryCard
              label="Tarefas pendentes"
              value={NUMBER_FORMATTER.format(report.totals.pendingTasks)}
              subtitle="Atribuídas ao seu escopo"
              icon={<PendingActionsOutlinedIcon fontSize="small" />}
            />
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
            <Stack
              direction={{ xs: "column", sm: "row" }}
              justifyContent="space-between"
              alignItems={{ xs: "flex-start", sm: "center" }}
              spacing={1}
              mb={2}
            >
              <Typography variant="h3" component="h2">
                Situação de vencimentos (janela de {report.expirations.windowDays} dias)
              </Typography>
              <Button size="small" variant="text" onClick={() => void navigate("/expirations")}>
                Abrir painel de vencimentos
              </Button>
            </Stack>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: { xs: "1fr 1fr", sm: "repeat(4, 1fr)" },
                gap: 2,
              }}
            >
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="error.main" fontWeight={600}>
                  Vencidos
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {NUMBER_FORMATTER.format(report.expirations.expired)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="warning.main" fontWeight={600}>
                  Próximos ({report.expirations.windowDays}d)
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {NUMBER_FORMATTER.format(report.expirations.expiringSoon)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="success.main" fontWeight={600}>
                  Em dia
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {NUMBER_FORMATTER.format(report.expirations.onTrack)}
                </Typography>
              </Paper>
              <Paper
                variant="outlined"
                sx={{ p: 1.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLow }}
              >
                <Typography variant="caption" color="text.secondary" fontWeight={600}>
                  Sem data de vencimento
                </Typography>
                <Typography variant="h3" sx={{ fontVariantNumeric: "tabular-nums" }}>
                  {NUMBER_FORMATTER.format(report.expirations.withoutDate)}
                </Typography>
              </Paper>
            </Box>
          </Paper>

          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: { xs: "1fr", lg: "1fr 1fr" },
              gap: 2.5,
            }}
          >
            <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
              <Typography variant="h3" component="h2" gutterBottom>
                Totais por status
              </Typography>
              {report.byStatus.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Nenhum documento corresponde aos filtros selecionados.
                </Typography>
              ) : (
                <TableContainer>
                  <Table size="small" aria-label="Totais de documentos por status">
                    <TableHead>
                      <TableRow>
                        <TableCell>Status</TableCell>
                        <TableCell align="right">Documentos</TableCell>
                        <TableCell sx={{ minWidth: 110 }}>Participação</TableCell>
                        <TableCell align="right">Espaço</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {report.byStatus.map((row) => {
                        const meta = DOCUMENT_STATUS_META[row.status];
                        const pct =
                          report.totals.totalDocuments > 0
                            ? Math.round((row.documentCount / report.totals.totalDocuments) * 100)
                            : 0;
                        return (
                          <TableRow key={row.status}>
                            <TableCell>
                              <Chip size="small" label={meta.label} color={meta.color} />
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {NUMBER_FORMATTER.format(row.documentCount)}
                            </TableCell>
                            <TableCell>
                              <Stack direction="row" spacing={1} alignItems="center">
                                <LinearProgress
                                  variant="determinate"
                                  value={pct}
                                  sx={{ flex: 1, height: 6, borderRadius: 1 }}
                                />
                                <Typography
                                  variant="caption"
                                  color="text.secondary"
                                  sx={{ minWidth: 32, textAlign: "right" }}
                                >
                                  {pct}%
                                </Typography>
                              </Stack>
                            </TableCell>
                            <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                              {formatBytesPtBr(row.storageBytes)}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>

            <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
              <Typography variant="h3" component="h2" gutterBottom>
                Espaço por conexão de armazenamento
              </Typography>
              {report.byStorageConnection.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  Nenhum arquivo ativo contabilizado no escopo selecionado.
                </Typography>
              ) : (
                <TableContainer>
                  <Table size="small" aria-label="Uso de espaço por conexão de armazenamento">
                    <TableHead>
                      <TableRow>
                        <TableCell>Conexão</TableCell>
                        <TableCell>Tipo</TableCell>
                        <TableCell align="right">Arquivos</TableCell>
                        <TableCell align="right">Espaço utilizado</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {report.byStorageConnection.map((row) => (
                        <TableRow key={row.storageConnectionId}>
                          <TableCell>
                            <Typography variant="body2" fontWeight={500}>
                              {row.storageConnectionName}
                            </Typography>
                          </TableCell>
                          <TableCell>{STORAGE_KIND_LABELS[row.kind] ?? row.kind}</TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                            {NUMBER_FORMATTER.format(row.fileCount)}
                          </TableCell>
                          <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                            {formatBytesPtBr(row.storageBytes)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
            </Paper>
          </Box>

          <Paper sx={{ p: 2.5, bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
            <Typography variant="h3" component="h2" gutterBottom>
              Totais por categoria documental
            </Typography>
            {report.byCategory.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                Nenhuma categoria com documentos para os filtros selecionados.
              </Typography>
            ) : (
              <TableContainer>
                <Table size="small" aria-label="Totais de documentos por categoria">
                  <TableHead>
                    <TableRow>
                      <TableCell>Categoria</TableCell>
                      <TableCell align="right">Documentos</TableCell>
                      <TableCell align="right">Versões</TableCell>
                      <TableCell align="right">Vencidos</TableCell>
                      <TableCell align="right">
                        Próximos ({report.expirations.windowDays}d)
                      </TableCell>
                      <TableCell align="right">Espaço utilizado</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {report.byCategory.map((row) => (
                      <TableRow key={row.categoryId} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={500}>
                            {row.categoryName}
                          </Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {NUMBER_FORMATTER.format(row.documentCount)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {NUMBER_FORMATTER.format(row.versionCount)}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.expiredCount > 0 ? (
                            <Chip
                              size="small"
                              color="error"
                              label={NUMBER_FORMATTER.format(row.expiredCount)}
                            />
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {row.expiringSoonCount > 0 ? (
                            <Chip
                              size="small"
                              color="warning"
                              label={NUMBER_FORMATTER.format(row.expiringSoonCount)}
                            />
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell align="right" sx={{ fontVariantNumeric: "tabular-nums" }}>
                          {formatBytesPtBr(row.storageBytes)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Paper>

          <Typography variant="caption" color="text.secondary">
            Relatório gerado em {new Date(report.generatedAt).toLocaleString("pt-BR")} • Fuso
            horário da organização: {report.timezone}
          </Typography>
        </Stack>
      )}
    </Stack>
  );
}
