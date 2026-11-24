import {
  Checkbox,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
} from "@mui/material";
import type { ChangeEvent, ReactNode } from "react";
import { DOCUFLOW_COLOR_TOKENS } from "../theme/tokens.js";
import { EmptyState } from "./EmptyState.js";
import { ErrorState } from "./ErrorState.js";
import { LoadingState } from "./LoadingState.js";

export interface DataTableColumn<TRow> {
  readonly id: string;
  readonly label: string;
  readonly sortable?: boolean;
  readonly align?: "left" | "right" | "center";
  readonly width?: number | string;
  readonly render: (row: TRow) => ReactNode;
}

export interface DataTableProps<TRow> {
  readonly ariaLabel: string;
  readonly columns: readonly DataTableColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly getRowId: (row: TRow) => string;
  readonly getRowLabel?: (row: TRow) => string;
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly pageSizeOptions?: readonly number[];
  readonly onPageChange: (nextPage: number) => void;
  readonly onPageSizeChange?: (nextPageSize: number) => void;
  readonly sortBy?: string;
  readonly sortDirection?: "asc" | "desc";
  readonly onSortChange?: (field: string, direction: "asc" | "desc") => void;
  readonly selectedIds?: readonly string[];
  readonly onSelectionChange?: (nextSelectedIds: string[]) => void;
  readonly onRowClick?: (row: TRow) => void;
  readonly loading?: boolean;
  readonly errorMessage?: string | null;
  readonly onRetry?: () => void;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly emptyActionLabel?: string;
  readonly onEmptyAction?: () => void;
}

export function DataTable<TRow>({
  ariaLabel,
  columns,
  rows,
  getRowId,
  getRowLabel,
  page,
  pageSize,
  totalItems,
  pageSizeOptions = [10, 20, 50],
  onPageChange,
  onPageSizeChange,
  sortBy,
  sortDirection = "asc",
  onSortChange,
  selectedIds,
  onSelectionChange,
  onRowClick,
  loading = false,
  errorMessage = null,
  onRetry,
  emptyTitle = "Nenhum registro encontrado",
  emptyDescription = "Ajuste os filtros aplicados ou cadastre um novo item.",
  emptyActionLabel,
  onEmptyAction,
}: DataTableProps<TRow>) {
  if (loading) {
    return <LoadingState message="Carregando registros..." />;
  }

  if (errorMessage) {
    return <ErrorState description={errorMessage} {...(onRetry ? { onRetry } : {})} />;
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        {...(emptyActionLabel && onEmptyAction
          ? { actionLabel: emptyActionLabel, onAction: onEmptyAction }
          : {})}
      />
    );
  }

  const selectionEnabled = selectedIds !== undefined && onSelectionChange !== undefined;
  const selectedSet = new Set(selectedIds ?? []);
  const rowIds = rows.map(getRowId);
  const selectedOnPageCount = rowIds.filter((id) => selectedSet.has(id)).length;
  const allOnPageSelected = rowIds.length > 0 && selectedOnPageCount === rowIds.length;
  const someOnPageSelected = selectedOnPageCount > 0 && selectedOnPageCount < rowIds.length;

  const handleToggleAllOnPage = (event: ChangeEvent<HTMLInputElement>): void => {
    if (!onSelectionChange) {
      return;
    }
    if (event.target.checked) {
      const next = new Set(selectedSet);
      for (const id of rowIds) {
        next.add(id);
      }
      onSelectionChange(Array.from(next));
    } else {
      const rowIdSet = new Set(rowIds);
      onSelectionChange(Array.from(selectedSet).filter((id) => !rowIdSet.has(id)));
    }
  };

  const handleToggleRow = (rowId: string): void => {
    if (!onSelectionChange) {
      return;
    }
    if (selectedSet.has(rowId)) {
      onSelectionChange(Array.from(selectedSet).filter((id) => id !== rowId));
    } else {
      onSelectionChange([...selectedSet, rowId]);
    }
  };

  const handleSortClick = (columnId: string): void => {
    if (!onSortChange) {
      return;
    }
    const isCurrent = sortBy === columnId;
    const nextDirection: "asc" | "desc" = isCurrent && sortDirection === "asc" ? "desc" : "asc";
    onSortChange(columnId, nextDirection);
  };

  return (
    <Paper sx={{ overflow: "hidden", bgcolor: DOCUFLOW_COLOR_TOKENS.surface.containerLowest }}>
      <TableContainer>
        <Table aria-label={ariaLabel}>
          <TableHead>
            <TableRow>
              {selectionEnabled ? (
                <TableCell padding="checkbox">
                  <Checkbox
                    checked={allOnPageSelected}
                    indeterminate={someOnPageSelected}
                    onChange={handleToggleAllOnPage}
                    inputProps={{ "aria-label": "Selecionar todos os itens da página" }}
                  />
                </TableCell>
              ) : null}
              {columns.map((column) => {
                const isSorted = sortBy === column.id;
                return (
                  <TableCell
                    key={column.id}
                    align={column.align ?? "left"}
                    style={column.width !== undefined ? { width: column.width } : undefined}
                    sortDirection={isSorted ? sortDirection : false}
                  >
                    {column.sortable && onSortChange ? (
                      <TableSortLabel
                        active={isSorted}
                        direction={isSorted ? sortDirection : "asc"}
                        onClick={() => handleSortClick(column.id)}
                      >
                        {column.label}
                      </TableSortLabel>
                    ) : (
                      column.label
                    )}
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              const rowId = getRowId(row);
              const isSelected = selectedSet.has(rowId);
              const rowLabel = getRowLabel ? getRowLabel(row) : rowId;

              return (
                <TableRow
                  key={rowId}
                  hover
                  selected={isSelected}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  sx={onRowClick ? { cursor: "pointer" } : undefined}
                >
                  {selectionEnabled ? (
                    <TableCell padding="checkbox" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onChange={() => handleToggleRow(rowId)}
                        inputProps={{ "aria-label": `Selecionar ${rowLabel}` }}
                      />
                    </TableCell>
                  ) : null}
                  {columns.map((column) => (
                    <TableCell key={column.id} align={column.align ?? "left"}>
                      {column.render(row)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={totalItems}
        page={Math.max(0, page - 1)}
        rowsPerPage={pageSize}
        rowsPerPageOptions={[...pageSizeOptions]}
        onPageChange={(_event, nextZeroBasedPage) => onPageChange(nextZeroBasedPage + 1)}
        onRowsPerPageChange={
          onPageSizeChange
            ? (event) => {
                const parsed = Number.parseInt(event.target.value, 10);
                if (!Number.isNaN(parsed) && parsed > 0) {
                  onPageSizeChange(parsed);
                }
              }
            : undefined
        }
        labelRowsPerPage="Itens por página:"
        labelDisplayedRows={({ from, to, count }) =>
          `${from}–${to} de ${count !== -1 ? count : `mais de ${to}`}`
        }
      />
    </Paper>
  );
}
