export type UiLocale = "en-US" | "pt-BR";

export const DEFAULT_UI_LOCALE: UiLocale = "en-US";

export const UI_LOCALE_STORAGE_KEY = "papyrus_ui_locale";

export interface UiLocaleOption {
  readonly code: UiLocale;
  readonly shortLabel: string;
  readonly nativeLabel: string;
}

export const SUPPORTED_UI_LOCALES: readonly UiLocaleOption[] = [
  { code: "en-US", shortLabel: "EN", nativeLabel: "English (US)" },
  { code: "pt-BR", shortLabel: "PT", nativeLabel: "Português (Brasil)" },
];

export function resolveUiLocale(raw: string | null | undefined): UiLocale {
  if (raw === "pt-BR") {
    return "pt-BR";
  }
  return "en-US";
}
