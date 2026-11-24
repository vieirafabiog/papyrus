import ClearOutlinedIcon from "@mui/icons-material/ClearOutlined";
import EventAvailableOutlinedIcon from "@mui/icons-material/EventAvailableOutlined";
import EventBusyOutlinedIcon from "@mui/icons-material/EventBusyOutlined";
import OpenInNewOutlinedIcon from "@mui/icons-material/OpenInNewOutlined";
import PublicOutlinedIcon from "@mui/icons-material/PublicOutlined";
import RefreshOutlinedIcon from "@mui/icons-material/RefreshOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import type {
  DocumentExpirationItem,
  DocumentStatus,
  ExpirationBucket,
  ExpirationState,
} from "@papyrus/contracts";
import { DataTable, type DataTableColumn, PAPYRUS_COLOR_TOKENS } from "@papyrus/ui";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { type MessageKey, useI18n } from "../../i18n/index.js";
import {
  useDocumentListCategoriesQuery,
  useDocumentOwnersQuery,
} from "../documents/useDocumentList.js";
import {
  DEFAULT_EXPIRATIONS_FILTERS,
  type ExpirationsFiltersState,
  type ExpirationsSortField,
  useDocumentExpirationsQuery,
} from "./useExpirations.js";

const DOCUMENT_STATUS_KEY: Readonly<Record<DocumentStatus, MessageKey>> = {
  DRAFT: "workflows.documentStatus.DRAFT",
  IN_REVIEW: "workflows.documentStatus.IN_REVIEW",
  APPROVED: "workflows.documentStatus.APPROVED",
  REJECTED: "workflows.documentStatus.REJECTED",
  ARCHIVED: "workflows.documentStatus.ARCHIVED",
  EXPIRED: "workflows.documentStatus.EXPIRED",
  DELETED: "workflows.documentStatus.DELETED",
};

const EXPIRATION_BADGE: Readonly<
  Record<
    ExpirationState,
    { readonly key: MessageKey; readonly color: "error" | "warning" | "success" | "default" }
  >
> = {
  EXPIRED: { key: "expirations.page.badge.EXPIRED", color: "error" },
  EXPIRING_SOON: { key: "expirations.page.badge.EXPIRING_SOON", color: "warning" },
  UP_TO_DATE: { key: "expirations.page.badge.UP_TO_DATE", color: "success" },
  NO_DATE: { key: "expirations.page.badge.NO_DATE", color: "default" },
};

const WINDOW_DAY_OPTIONS = [7, 15, 30, 60, 90] as const;
const SERVER_SORTABLE_FIELDS = new Set<string>(["expirationDate", "title", "status", "updatedAt"]);

function parseIsoCalendarDate(isoDate: string): Date | string {
  const [yearRaw, monthRaw, dayRaw] = isoDate.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return isoDate;
  }
  return new Date(year, month - 1, day);
}

/**
 * Authorized document expiration monitoring page filtering overdue, expiring-soon,
 * up-to-date, and undated documents according to the organization timezone.
 */
export function ExpirationsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ExpirationsFiltersState>(DEFAULT_EXPIRATIONS_FILTERS);

  const expirationsQuery = useDocumentExpirationsQuery(filters);
  const categoriesQuery = useDocumentListCategoriesQuery();
  const ownersQuery = useDocumentOwnersQuery();

  const updateFilters = (patch: Partial<ExpirationsFiltersState>): void => {
    setFilters((prev) => ({
      ...prev,
      ...patch,
    }));
  };

  const clearFilters = (): void => {
    setFilters((prev) => ({
      ...DEFAULT_EXPIRATIONS_FILTERS,
      pageSize: prev.pageSize,
    }));
  };

  const formatIsoDate = (isoDate: string | null): string => {
    if (!isoDate) {
      return t("expirations.page.noDate");
    }
    return formatDate(parseIsoCalendarDate(isoDate), t("expirations.page.noDate"));
  };

  const formatExpirationDeltaLabel = (item: DocumentExpirationItem): string => {
    if (item.daysUntilExpiration === null) {
      return t("expirations.page.delta.noDate");
    }
    if (item.daysUntilExpiration < 0) {
      const overdueDays = Math.abs(item.daysUntilExpiration);
      return overdueDays === 1
        ? t("expirations.page.delta.expiredSingular")
        : t("expirations.page.delta.expiredPlural", { count: formatNumber(overdueDays) });
    }
    if (item.daysUntilExpiration === 0) {
      return t("expirations.page.delta.expiresToday");
    }
    if (item.daysUntilExpiration === 1) {
      return t("expirations.page.delta.expiresSingular");
    }
    return t("expirations.page.delta.expiresPlural", {
      count: formatNumber(item.daysUntilExpiration),
    });
  };

  const hasActiveFilters =
    filters.bucket !== "ALL" ||
    filters.windowDays !== 30 ||
    filters.categoryId.length > 0 ||
    filters.ownerUserId.length > 0 ||
    filters.search.trim().length > 0 ||
    filters.includeArchived;

  const data = expirationsQuery.data;
  const summary = data?.summary;
  const totalTracked = summary
    ? summary.expiredCount +
      summary.expiringSoonCount +
      summary.upToDateCount +
      summary.noExpirationCount
    : null;

  const columns: readonly DataTableColumn<DocumentExpirationItem>[] = [
    {
      id: "title",
      label: t("expirations.page.columns.document"),
      sortable: true,
      render: (row) => (
        <Box>
          <Typography variant="body2" fontWeight={600}>
            {row.title}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.categoryName ?? row.categoryId}
          </Typography>
        </Box>
      ),
    },
    {
      id: "ownerName",
      label: t("expirations.page.columns.owner"),
      render: (row) => <Typography variant="body2">{row.ownerName ?? row.ownerUserId}</Typography>,
    },
    {
      id: "status",
      label: t("expirations.page.columns.status"),
      sortable: true,
      width: 140,
      render: (row) => (
        <Chip size="small" variant="outlined" label={t(DOCUMENT_STATUS_KEY[row.status])} />
      ),
    },
    {
      id: "expirationDate",
      label: t("expirations.page.columns.expirationDate"),
      sortable: true,
      width: 165,
      render: (row) => (
        <Typography
          variant="body2"
          fontWeight={row.expirationState === "EXPIRED" ? 600 : 400}
          sx={{ fontVariantNumeric: "tabular-nums" }}
        >
          {formatIsoDate(row.expirationDate)}
        </Typography>
      ),
    },
    {
      id: "expirationSituation",
      label: t("expirations.page.columns.situation"),
      width: 240,
      render: (row) => {
        const badge = EXPIRATION_BADGE[row.expirationState];
        return (
          <Stack spacing={0.5} alignItems="flex-start">
            <Chip size="small" label={t(badge.key)} color={badge.color} />
            <Typography variant="caption" color="text.secondary">
              {formatExpirationDeltaLabel(row)}
            </Typography>
          </Stack>
        );
      },
    },
    {
      id: "actions",
      label: t("expirations.page.columns.action"),
      align: "right",
      width: 145,
      render: (row) => (
        <Button
          size="small"
          variant="text"
          endIcon={<OpenInNewOutlinedIcon fontSize="small" />}
          onClick={(event) => {
            event.stopPropagation();
            navigate(`/documents/${encodeURIComponent(row.id)}`);
          }}
        >
          {t("expirations.page.actions.open")}
        </Button>
      ),
    },
  ];

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", md: "row" }}
        justifyContent="space-between"
        alignItems={{ xs: "flex-start", md: "center" }}
        spacing={2}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <EventBusyOutlinedIcon color="primary" fontSize="small" />
            <Typography variant="h1">{t("expirations.page.title")}</Typography>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {t("expirations.page.subtitle")}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          {data ? (
            <Chip
              size="small"
              variant="outlined"
              icon={<PublicOutlinedIcon fontSize="small" />}
              label={t("expirations.page.timezoneChip", {
                timezone: data.timezone,
                date: formatIsoDate(data.referenceDate),
              })}
            />
          ) : null}
          <Button
            variant="outlined"
            size="small"
            startIcon={<RefreshOutlinedIcon />}
            disabled={expirationsQuery.isFetching}
            onClick={() => void expirationsQuery.refetch()}
          >
            {t("expirations.page.refresh")}
          </Button>
        </Stack>
      </Stack>

      <Paper sx={{ bgcolor: PAPYRUS_COLOR_TOKENS.surface.containerLowest }}>
        <Tabs
          value={filters.bucket}
          onChange={(_event, nextValue: ExpirationBucket) =>
            updateFilters({ bucket: nextValue, page: 1 })
          }
          variant="scrollable"
          scrollButtons="auto"
          aria-label={t("expirations.page.tabsAriaLabel")}
          sx={{ px: 2, borderBottom: 1, borderColor: "divider" }}
        >
          <Tab
            value="ALL"
            label={
              totalTracked !== null
                ? t("expirations.page.tabs.allWithCount", { count: formatNumber(totalTracked) })
                : t("expirations.page.tabs.all")
            }
          />
          <Tab
            value="EXPIRED"
            label={
              summary
                ? t("expirations.page.tabs.expiredWithCount", {
                    count: formatNumber(summary.expiredCount),
                  })
                : t("expirations.page.tabs.expired")
            }
          />
          <Tab
            value="EXPIRING_SOON"
            label={
              summary
                ? t("expirations.page.tabs.soonWithCount", {
                    count: formatNumber(summary.expiringSoonCount),
                  })
                : t("expirations.page.tabs.soon")
            }
          />
          <Tab
            value="NO_DATE"
            label={
              summary
                ? t("expirations.page.tabs.noDateWithCount", {
                    count: formatNumber(summary.noExpirationCount),
                  })
                : t("expirations.page.tabs.noDate")
            }
          />
          <Tab
            value="UP_TO_DATE"
            icon={<EventAvailableOutlinedIcon fontSize="small" />}
            iconPosition="start"
            label={
              summary
                ? t("expirations.page.tabs.upToDateWithCount", {
                    count: formatNumber(summary.upToDateCount),
                  })
                : t("expirations.page.tabs.upToDate")
            }
          />
        </Tabs>

        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Stack
            direction={{ xs: "column", md: "row" }}
            spacing={1.5}
            alignItems={{ xs: "stretch", md: "center" }}
            flexWrap="wrap"
            useFlexGap
          >
            <TextField
              id="expirations-search"
              size="small"
              label={t("expirations.page.filters.searchLabel")}
              placeholder={t("expirations.page.filters.searchPlaceholder")}
              value={filters.search}
              onChange={(event) => updateFilters({ search: event.target.value, page: 1 })}
              sx={{ minWidth: { xs: "100%", sm: 240 } }}
              slotProps={{
                input: {
                  startAdornment: (
                    <InputAdornment position="start">
                      <SearchOutlinedIcon fontSize="small" color="action" />
                    </InputAdornment>
                  ),
                },
              }}
            />

            <FormControl size="small" sx={{ minWidth: 165 }}>
              <InputLabel id="expirations-window-label">
                {t("expirations.page.filters.windowLabel")}
              </InputLabel>
              <Select
                labelId="expirations-window-label"
                id="expirations-window"
                value={String(filters.windowDays)}
                label={t("expirations.page.filters.windowLabel")}
                onChange={(event) => {
                  const days = Number.parseInt(String(event.target.value), 10);
                  if (!Number.isNaN(days) && days > 0) {
                    updateFilters({ windowDays: days, page: 1 });
                  }
                }}
              >
                {WINDOW_DAY_OPTIONS.map((days) => (
                  <MenuItem key={days} value={String(days)}>
                    {t("expirations.page.filters.windowOption", { days })}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="expirations-category-label">
                {t("expirations.page.filters.categoryLabel")}
              </InputLabel>
              <Select
                labelId="expirations-category-label"
                id="expirations-category"
                value={filters.categoryId}
                label={t("expirations.page.filters.categoryLabel")}
                onChange={(event) =>
                  updateFilters({ categoryId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">{t("expirations.page.filters.allCategories")}</MenuItem>
                {(categoriesQuery.data ?? []).map((category) => (
                  <MenuItem key={category.id} value={category.id}>
                    {category.name}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 190 }}>
              <InputLabel id="expirations-owner-label">
                {t("expirations.page.filters.ownerLabel")}
              </InputLabel>
              <Select
                labelId="expirations-owner-label"
                id="expirations-owner"
                value={filters.ownerUserId}
                label={t("expirations.page.filters.ownerLabel")}
                onChange={(event) =>
                  updateFilters({ ownerUserId: String(event.target.value), page: 1 })
                }
              >
                <MenuItem value="">{t("expirations.page.filters.allOwners")}</MenuItem>
                {(ownersQuery.data ?? []).map((owner) => (
                  <MenuItem key={owner.id} value={owner.id}>
                    {owner.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControlLabel
              control={
                <Switch
                  checked={filters.includeArchived}
                  onChange={(_event, checked) =>
                    updateFilters({ includeArchived: checked, page: 1 })
                  }
                />
              }
              label={t("expirations.page.filters.includeArchived")}
            />

            {hasActiveFilters ? (
              <Button
                variant="text"
                size="small"
                startIcon={<ClearOutlinedIcon fontSize="small" />}
                onClick={clearFilters}
              >
                {t("expirations.page.filters.clear")}
              </Button>
            ) : null}
          </Stack>
        </Stack>
      </Paper>

      <DataTable
        ariaLabel={t("expirations.page.tableAriaLabel")}
        columns={columns}
        rows={data?.items ?? []}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        page={data?.pagination.page ?? filters.page}
        pageSize={data?.pagination.pageSize ?? filters.pageSize}
        totalItems={data?.pagination.totalItems ?? 0}
        onPageChange={(nextPage) => updateFilters({ page: nextPage })}
        onPageSizeChange={(nextPageSize) => updateFilters({ pageSize: nextPageSize, page: 1 })}
        sortBy={filters.sortBy}
        sortDirection={filters.sortDirection}
        onSortChange={(field, direction) => {
          if (SERVER_SORTABLE_FIELDS.has(field)) {
            updateFilters({
              sortBy: field as ExpirationsSortField,
              sortDirection: direction,
              page: 1,
            });
          }
        }}
        onRowClick={(row) => navigate(`/documents/${encodeURIComponent(row.id)}`)}
        loading={expirationsQuery.isPending}
        errorMessage={expirationsQuery.isError ? expirationsQuery.error.message : null}
        onRetry={() => void expirationsQuery.refetch()}
        emptyTitle={
          hasActiveFilters
            ? t("expirations.page.emptyFilteredTitle")
            : t("expirations.page.emptyDefaultTitle")
        }
        emptyDescription={
          hasActiveFilters
            ? t("expirations.page.emptyFilteredDescription")
            : t("expirations.page.emptyDefaultDescription")
        }
        {...(hasActiveFilters
          ? { emptyActionLabel: t("expirations.page.filters.clear"), onEmptyAction: clearFilters }
          : {})}
      />
    </Stack>
  );
}
