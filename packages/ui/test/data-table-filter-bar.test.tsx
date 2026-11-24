import "@testing-library/jest-dom/vitest";
import { ThemeProvider } from "@mui/material/styles";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DataTable,
  type DataTableColumn,
  FilterBar,
  UiLocaleProvider,
  createPapyrusTheme,
  papyrusTheme,
} from "../src/index.js";

interface SampleDoc {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const COLUMNS: readonly DataTableColumn<SampleDoc>[] = [
  { id: "title", label: "Title", sortable: true, render: (row) => row.title },
  { id: "status", label: "Status", sortable: false, render: (row) => row.status },
];

const ROWS: readonly SampleDoc[] = [
  { id: "doc-1", title: "Contract A", status: "DRAFT" },
  { id: "doc-2", title: "Contract B", status: "APPROVED" },
];

function renderWithTheme(ui: ReactNode) {
  return render(<ThemeProvider theme={papyrusTheme}>{ui}</ThemeProvider>);
}

describe("DataTable and FilterBar", () => {
  afterEach(() => {
    cleanup();
  });

  it("delegates sorting, pagination, and accessible selection in en-US by default", () => {
    const onPageChange = vi.fn();
    const onSortChange = vi.fn();
    const onSelectionChange = vi.fn();

    renderWithTheme(
      <DataTable
        ariaLabel="Documents table"
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

    fireEvent.click(screen.getByRole("button", { name: "Title" }));
    expect(onSortChange).toHaveBeenCalledWith("title", "desc");

    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contract A" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["doc-1"]);

    fireEvent.click(screen.getByRole("checkbox", { name: "Select all items on this page" }));
    expect(onSelectionChange).toHaveBeenCalledWith(["doc-1", "doc-2"]);

    fireEvent.click(screen.getByRole("button", { name: /next page/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("renders pt-BR labels via UiLocaleProvider and createPapyrusTheme('pt-BR')", () => {
    const onPageChange = vi.fn();
    render(
      <UiLocaleProvider locale="pt-BR">
        <ThemeProvider theme={createPapyrusTheme("pt-BR")}>
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
            selectedIds={[]}
            onSelectionChange={vi.fn()}
          />
        </ThemeProvider>
      </UiLocaleProvider>,
    );

    expect(
      screen.getByRole("checkbox", { name: "Selecionar todos os itens da página" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /próxima página/i })).toBeInTheDocument();
  });

  it("renders empty state when there are no rows", () => {
    const onEmptyAction = vi.fn();
    renderWithTheme(
      <DataTable
        ariaLabel="Empty table"
        columns={COLUMNS}
        rows={[]}
        getRowId={(row) => row.id}
        page={1}
        pageSize={10}
        totalItems={0}
        onPageChange={vi.fn()}
        emptyTitle="No documents"
        emptyDescription="Upload a file to begin."
        emptyActionLabel="New document"
        onEmptyAction={onEmptyAction}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New document" }));
    expect(onEmptyAction).toHaveBeenCalledTimes(1);
  });

  it("triggers FilterBar search, filter select, and clear callbacks", () => {
    const onSearchChange = vi.fn();
    const onStatusChange = vi.fn();
    const onClearFilters = vi.fn();

    renderWithTheme(
      <FilterBar
        searchValue="contract"
        onSearchChange={onSearchChange}
        filters={[
          {
            id: "status",
            label: "Status",
            value: "DRAFT",
            options: [
              { value: "DRAFT", label: "Draft" },
              { value: "APPROVED", label: "Approved" },
            ],
            onChange: onStatusChange,
          },
        ]}
        hasActiveFilters={true}
        onClearFilters={onClearFilters}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onSearchChange).toHaveBeenCalledWith("");

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
