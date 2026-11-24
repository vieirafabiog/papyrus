import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  formatBytes as formatBytesForLocale,
  formatDate as formatDateForLocale,
  formatDateTime as formatDateTimeForLocale,
  formatNumber as formatNumberForLocale,
} from "./formatters.js";
import { adminEn, adminPt } from "./messages/admin.js";
import { commonEn, commonPt } from "./messages/common.js";
import { documentsEn, documentsPt } from "./messages/documents.js";
import { workflowsEn, workflowsPt } from "./messages/workflows.js";
import {
  DEFAULT_UI_LOCALE,
  UI_LOCALE_STORAGE_KEY,
  type UiLocale,
  resolveUiLocale,
} from "./types.js";

const EN_MESSAGES = {
  ...commonEn,
  ...documentsEn,
  ...workflowsEn,
  ...adminEn,
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

const PT_MESSAGES: Readonly<Record<MessageKey, string>> = {
  ...commonPt,
  ...documentsPt,
  ...workflowsPt,
  ...adminPt,
};

const DICTIONARIES: Readonly<Record<UiLocale, Readonly<Record<MessageKey, string>>>> = {
  "en-US": EN_MESSAGES,
  "pt-BR": PT_MESSAGES,
};

export type TranslationParams = Readonly<Record<string, string | number>>;

let currentModuleLocale: UiLocale = DEFAULT_UI_LOCALE;

export function getStoredUiLocale(): UiLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (raw === "en-US" || raw === "pt-BR") {
      return raw;
    }
  } catch {
    // Ignore storage access errors in restricted environments.
  }
  return null;
}

export function getCurrentUiLocale(): UiLocale {
  return currentModuleLocale;
}

export function setGlobalUiLocale(nextLocale: UiLocale): void {
  currentModuleLocale = nextLocale;
  if (typeof document !== "undefined") {
    document.documentElement.lang = nextLocale;
  }
}

export function resetUiLocaleForTests(): void {
  currentModuleLocale = DEFAULT_UI_LOCALE;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(UI_LOCALE_STORAGE_KEY);
    } catch {
      // Ignore storage cleanup errors in test teardown.
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = DEFAULT_UI_LOCALE;
  }
}

export function interpolate(template: string, params?: TranslationParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, token: string) => {
    const value = params[token];
    return value !== undefined ? String(value) : match;
  });
}

export function translate(
  key: MessageKey,
  params?: TranslationParams,
  locale: UiLocale = currentModuleLocale,
): string {
  const dictionary = DICTIONARIES[locale] ?? EN_MESSAGES;
  const template = dictionary[key] ?? EN_MESSAGES[key];
  return interpolate(template, params);
}

export interface I18nContextValue {
  readonly locale: UiLocale;
  readonly setLocale: (nextLocale: UiLocale) => void;
  readonly t: (key: MessageKey, params?: TranslationParams) => string;
  readonly formatDate: (value: string | Date | null | undefined, emptyFallback?: string) => string;
  readonly formatDateTime: (
    value: string | Date | null | undefined,
    emptyFallback?: string,
  ) => string;
  readonly formatNumber: (value: number) => string;
  readonly formatBytes: (bytes: number) => string;
}

const DEFAULT_CONTEXT_VALUE: I18nContextValue = {
  locale: DEFAULT_UI_LOCALE,
  setLocale: (nextLocale) => {
    const resolved = resolveUiLocale(nextLocale);
    setGlobalUiLocale(resolved);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, resolved);
      } catch {
        // Ignore storage errors.
      }
    }
  },
  t: (key, params) => translate(key, params, currentModuleLocale),
  formatDate: (value, emptyFallback) =>
    formatDateForLocale(value, currentModuleLocale, emptyFallback),
  formatDateTime: (value, emptyFallback) =>
    formatDateTimeForLocale(value, currentModuleLocale, emptyFallback),
  formatNumber: (value) => formatNumberForLocale(value, currentModuleLocale),
  formatBytes: (bytes) => formatBytesForLocale(bytes, currentModuleLocale),
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT_VALUE);

export interface I18nProviderProps {
  readonly children: ReactNode;
  readonly initialLocale?: UiLocale | undefined;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  const [locale, setLocaleState] = useState<UiLocale>(() => {
    const resolved = resolveUiLocale(initialLocale ?? getStoredUiLocale() ?? DEFAULT_UI_LOCALE);
    currentModuleLocale = resolved;
    return resolved;
  });

  useEffect(() => {
    setGlobalUiLocale(locale);
  }, [locale]);

  const setLocale = useCallback((nextLocale: UiLocale): void => {
    const resolved = resolveUiLocale(nextLocale);
    setGlobalUiLocale(resolved);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, resolved);
      } catch {
        // Ignore storage write errors in private/restricted browsers.
      }
    }
    setLocaleState(resolved);
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, params) => translate(key, params, locale),
      formatDate: (dateValue, emptyFallback) =>
        formatDateForLocale(dateValue, locale, emptyFallback),
      formatDateTime: (dateValue, emptyFallback) =>
        formatDateTimeForLocale(dateValue, locale, emptyFallback),
      formatNumber: (numValue) => formatNumberForLocale(numValue, locale),
      formatBytes: (bytes) => formatBytesForLocale(bytes, locale),
    }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export {
  DEFAULT_UI_LOCALE,
  SUPPORTED_UI_LOCALES,
  UI_LOCALE_STORAGE_KEY,
  resolveUiLocale,
  type UiLocale,
} from "./types.js";
export { formatBytes, formatDate, formatDateTime, formatNumber } from "./formatters.js";
