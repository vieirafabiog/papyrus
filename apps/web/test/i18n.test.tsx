import "@testing-library/jest-dom/vitest";
import { DataTable, ErrorState, PapyrusLogo } from "@docuflow/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "../src/app/providers.js";
import { LoginPage } from "../src/features/auth/LoginPage.js";
import { UI_LOCALE_STORAGE_KEY, resetUiLocaleForTests } from "../src/i18n/index.js";

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function I18nTestHarness() {
  return (
    <>
      <PapyrusLogo showTagline />
      <LoginPage />
      <ErrorState description="Sample error description" onRetry={vi.fn()} />
      <DataTable
        ariaLabel="Sample documents"
        columns={[
          {
            id: "title",
            label: "Title",
            render: (row: { id: string; title: string }) => row.title,
          },
        ]}
        rows={[{ id: "doc-1", title: "Contract A" }]}
        getRowId={(row) => row.id}
        page={1}
        pageSize={10}
        totalItems={25}
        onPageChange={vi.fn()}
      />
    </>
  );
}

describe("Web i18n and dynamic MUI + @docuflow/ui localization", () => {
  let originalLocalStorageDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      value: createMemoryStorage(),
      configurable: true,
      writable: true,
    });
    resetUiLocaleForTests();
  });

  afterEach(() => {
    cleanup();
    resetUiLocaleForTests();
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(window, "localStorage", originalLocalStorageDescriptor);
    }
    vi.restoreAllMocks();
  });

  it("defaults to en-US, switches dynamically to pt-BR via LanguageSwitcher, and persists across mounts", async () => {
    const firstRender = render(
      <AppProviders>
        <I18nTestHarness />
      </AppProviders>,
    );

    expect(document.documentElement.lang).toBe("en-US");
    expect(screen.getByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
    expect(screen.getByText("Access your organization's document library.")).toBeInTheDocument();
    expect(screen.getByText("Document Management")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Unable to load data" })).toBeInTheDocument();
    expect(screen.getByText("Items per page:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to next page" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change language" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Português (Brasil)" }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("pt-BR");
    });
    expect(window.localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("pt-BR");

    expect(screen.getByRole("heading", { name: "Entrar no papyrus" })).toBeInTheDocument();
    expect(
      screen.getByText("Acesse a biblioteca de documentos da sua organização."),
    ).toBeInTheDocument();
    expect(screen.getByText("Gestão de Documentos")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Não foi possível carregar os dados" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tentar novamente" })).toBeInTheDocument();
    expect(screen.getByText("Itens por página:")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ir para a próxima página" })).toBeInTheDocument();

    firstRender.unmount();

    render(
      <AppProviders>
        <I18nTestHarness />
      </AppProviders>,
    );

    expect(document.documentElement.lang).toBe("pt-BR");
    expect(screen.getByRole("heading", { name: "Entrar no papyrus" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Alterar idioma" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "English (US)" }));

    await waitFor(() => {
      expect(document.documentElement.lang).toBe("en-US");
    });
    expect(window.localStorage.getItem(UI_LOCALE_STORAGE_KEY)).toBe("en-US");
    expect(screen.getByRole("heading", { name: "Sign in to papyrus" })).toBeInTheDocument();
  });
});
