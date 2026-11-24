import { type ReactNode, createContext, useContext, useMemo } from "react";

export type PapyrusLocale = "en-US" | "pt-BR" | "es-ES";

export const DEFAULT_PAPYRUS_LOCALE: PapyrusLocale = "en-US";

export interface UiComponentMessages {
  readonly confirmDialog: {
    readonly confirm: string;
    readonly cancel: string;
    readonly processing: string;
  };
  readonly dataTable: {
    readonly loadingRecords: string;
    readonly emptyTitle: string;
    readonly emptyDescription: string;
    readonly selectAllOnPage: string;
    readonly selectRow: (label: string) => string;
    readonly rowsPerPage: string;
    readonly displayedRows: (from: number, to: number, count: number) => string;
  };
  readonly errorState: {
    readonly defaultTitle: string;
    readonly retry: string;
  };
  readonly filterBar: {
    readonly searchLabel: string;
    readonly searchPlaceholder: string;
    readonly clearSearch: string;
    readonly allOption: string;
    readonly clearFilters: string;
  };
  readonly loadingState: {
    readonly defaultMessage: string;
  };
  readonly papyrusLogo: {
    readonly defaultTagline: string;
  };
}

const EN_US_UI_MESSAGES: UiComponentMessages = {
  confirmDialog: {
    confirm: "Confirm",
    cancel: "Cancel",
    processing: "Processing...",
  },
  dataTable: {
    loadingRecords: "Loading records...",
    emptyTitle: "No records found",
    emptyDescription: "Adjust the filters or add a new item.",
    selectAllOnPage: "Select all items on this page",
    selectRow: (label) => `Select ${label}`,
    rowsPerPage: "Items per page:",
    displayedRows: (from, to, count) =>
      `${from}–${to} of ${count !== -1 ? count : `more than ${to}`}`,
  },
  errorState: {
    defaultTitle: "Unable to load data",
    retry: "Try again",
  },
  filterBar: {
    searchLabel: "Search",
    searchPlaceholder: "Type to search...",
    clearSearch: "Clear search",
    allOption: "All",
    clearFilters: "Clear filters",
  },
  loadingState: {
    defaultMessage: "Loading...",
  },
  papyrusLogo: {
    defaultTagline: "Document Management",
  },
};

const PT_BR_UI_MESSAGES: UiComponentMessages = {
  confirmDialog: {
    confirm: "Confirmar",
    cancel: "Cancelar",
    processing: "Processando...",
  },
  dataTable: {
    loadingRecords: "Carregando registros...",
    emptyTitle: "Nenhum registro encontrado",
    emptyDescription: "Ajuste os filtros aplicados ou cadastre um novo item.",
    selectAllOnPage: "Selecionar todos os itens da página",
    selectRow: (label) => `Selecionar ${label}`,
    rowsPerPage: "Itens por página:",
    displayedRows: (from, to, count) =>
      `${from}–${to} de ${count !== -1 ? count : `mais de ${to}`}`,
  },
  errorState: {
    defaultTitle: "Não foi possível carregar os dados",
    retry: "Tentar novamente",
  },
  filterBar: {
    searchLabel: "Buscar",
    searchPlaceholder: "Digite para pesquisar...",
    clearSearch: "Limpar busca",
    allOption: "Todos",
    clearFilters: "Limpar filtros",
  },
  loadingState: {
    defaultMessage: "Carregando...",
  },
  papyrusLogo: {
    defaultTagline: "Gestão de Documentos",
  },
};

const UI_MESSAGES_BY_LOCALE: Readonly<Record<PapyrusLocale, UiComponentMessages>> = {
  "en-US": EN_US_UI_MESSAGES,
  "pt-BR": PT_BR_UI_MESSAGES,
  "es-ES": EN_US_UI_MESSAGES,
};

export interface UiLocaleContextValue {
  readonly locale: PapyrusLocale;
  readonly messages: UiComponentMessages;
}

const UiLocaleContext = createContext<UiLocaleContextValue>({
  locale: DEFAULT_PAPYRUS_LOCALE,
  messages: EN_US_UI_MESSAGES,
});

export interface UiLocaleProviderProps {
  readonly locale: PapyrusLocale;
  readonly children: ReactNode;
}

export function UiLocaleProvider({ locale, children }: UiLocaleProviderProps) {
  const value = useMemo<UiLocaleContextValue>(
    () => ({
      locale,
      messages: UI_MESSAGES_BY_LOCALE[locale],
    }),
    [locale],
  );

  return <UiLocaleContext.Provider value={value}>{children}</UiLocaleContext.Provider>;
}

export function useUiLocale(): UiLocaleContextValue {
  return useContext(UiLocaleContext);
}
