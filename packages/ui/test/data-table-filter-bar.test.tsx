import "@testing-library/jest-dom/vitest";
import { ThemeProvider } from "@mui/material/styles";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn, FilterBar, docuflowTheme } from "../src/index.js";

interface SampleDoc {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const COLUMNS: readonly DataTableColumn<SampleDoc>[] = [
  { id: "title", label: "Título", sortable: true, render: (row) => row.title },
  { id: "status", label: "Status", sortable: false, render: (row) => row.status },
];

const ROWS: readonly SampleDoc[] = [
  { id: "doc-1", title: "Contrato A", status: "DRAFT" },
  { id: "doc-2", title: "Contrato B", status: "APPROVED" },
];

function renderWithTheme(ui: ReactNode) {
  return render(<ThemeProvider theme={docuflowTheme}>{ui}</ThemeProvider>);
}

describe("DataTable and FilterBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("delegates sorting, pagination, and accessible selection to server callbacks", () => {
    const onPageChange = vi.fn();
    const onSortChange = vi.fn();
    const onSelectionChange = vi.fn();

    renderWithTheme(
      <DataTable
        ariaLabel="Tabela de documentos"
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(row) => row.id}
        getRowLabel={(row) => row.title}
        page={1}
        pageSize={10}
        totalItems={25}
        onPageChange={onPageChange}
        sortBy="title"
        sortDirection="asc"
        onSortChange={onSortChange}
        selectedIds={[]}
        onSelectionChange={onSelectionChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Título" }));
    expect(onSortChange).toHaveBeenCalledWith("title", "desc");

    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar Contrato A" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["doc-1"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar todos os itens da página" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["doc-1", "doc-2"]);

    fireEvent.click(screen.getByRole("button", { name: /próxima página/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("renders empty state when there are no rows", () => {
    const onEmptyAction = vi.fn();
    renderWithTheme(
      <DataTable
        ariaLabel="Tabela vazia"
        columns={COLUMNS}
        rows={[]}
        getRowId={(row) => row.id}
        page={1}
        pageSize={10}
        totalItems={0}
        onPageChange={vi.fn()}
        emptyTitle="Nenhum documento"
        emptyDescription="Envie um arquivo para começar."
        emptyActionLabel="Novo documento"
        onEmptyAction={onEmptyAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Novo documento" }));
    expect(onEmptyAction).toHaveBeenCalledTimes(1);
  });

  it("triggers FilterBar search, filter select, and clear callbacks", () => {
    const onSearchChange = vi.fn();
    const onStatusChange = vi.fn();
    const onClearFilters = vi.fn();

    renderWithTheme(
      <FilterBar
        searchValue="contrato"
        onSearchChange={onSearchChange}
        filters={[
          {
            id: "status",
            label: "Status",
            value: "DRAFT",
            options: [
              { value: "DRAFT", label: "Rascunho" },
              { value: "APPROVED", label: "Aprovado" },
            ],
            onChange: onStatusChange,
          },
        ]}
        hasActiveFilters={true}
        onClearFilters={onClearFilters}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Limpar busca" }));
    expect(onSearchChange).toHaveBeenCalledWith("");

    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
