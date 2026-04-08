import { createSignal, createRoot } from "solid-js";
import en from "./locales/en";
import ja from "./locales/ja";
import zh from "./locales/zh";
import vi from "./locales/vi";
import ptBR from "./locales/pt-BR";
import th from "./locales/th";
import { LANGUAGE_PREF_KEY } from "../app/constants";

/**
 * Supported languages
 */
export type Language = "en" | "ja" | "zh" | "vi" | "pt-BR" | "th";
export type Locale = Language;
export type TranslationParams = Record<string, string | number>;
export type SourceFirstTranslate = (key: string, defaultValue: string, params?: TranslationParams) => string;
type TranslationArgs = {
  localeOverride?: Language;
  params?: TranslationParams;
};

/**
 * All supported languages - single source of truth
 */
export const LANGUAGES: Language[] = ["en", "ja", "zh", "vi", "pt-BR", "th"];

/**
 * Language options for UI - single source of truth
 */
export const LANGUAGE_OPTIONS = [
  { value: "en" as Language, label: "English", nativeName: "English" },
  { value: "ja" as Language, label: "日本語", nativeName: "日本語" },
  { value: "zh" as Language, label: "简体中文", nativeName: "简体中文" },
  { value: "vi" as Language, label: "Vietnamese", nativeName: "Tiếng Việt" },
  { value: "pt-BR" as Language, label: "Portuguese (BR)", nativeName: "Português (BR)" },
  { value: "th" as Language, label: "ไทย", nativeName: "ไทย" },
] as const;

/**
 * Translation maps
 */
const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en,
  ja,
  zh,
  vi,
    "pt-BR": ptBR,
  th,
};

/**
 * Type guard to validate if a value is a Language
 * Replaces long chains like: value === "en" || value === "zh"
 */
export const isLanguage = (value: unknown): value is Language => {
  return typeof value === "string" && LANGUAGES.includes(value as Language);
};

/**
 * Create root-level locale signal with persistence
 */
const [locale, setLocaleSignal] = createRoot(() => createSignal<Language>("en"));

/**
 * Get current locale
 */
export const currentLocale = (): Language => locale();

const formatTranslation = (value: string, params?: TranslationParams): string => {
  if (!params) return value;

  let result = value;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(`{${k}}`, String(v));
  }

  return result;
};

const parseTranslationArgs = (
  localeOrParams?: Language | TranslationParams,
  params?: TranslationParams,
): TranslationArgs => {
  if (typeof localeOrParams === "string") {
    return { localeOverride: localeOrParams, params };
  }

  return { localeOverride: undefined, params: localeOrParams };
};

const resolveTranslation = (key: string, localeOverride?: Language, defaultValue?: string): string => {
  const loc = localeOverride ?? locale();

  if (defaultValue != null && loc === "en") {
    return defaultValue;
  }

  if (TRANSLATIONS[loc]?.[key]) {
    return TRANSLATIONS[loc][key];
  }

  if (defaultValue != null) {
    return defaultValue;
  }

  if (loc !== "en" && TRANSLATIONS.en?.[key]) {
    return TRANSLATIONS.en[key];
  }

  return key;
};

/**
 * Set locale and persist to localStorage
 */
export const setLocale = (newLocale: Language) => {
  if (!isLanguage(newLocale)) {
    console.warn(`Invalid locale: ${newLocale}, falling back to "en"`);
    newLocale = "en";
  }

  setLocaleSignal(newLocale);

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", newLocale);
  }

  // Persist to localStorage
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LANGUAGE_PREF_KEY, newLocale);
    } catch (e) {
      console.warn("Failed to persist language preference:", e);
    }
  }
};

/**
 * Translation function with fallback behavior
 * Fallback chain: target language → English → key itself
 *
 * @param key - Translation key
 * @param localeOverride - Optional locale override (defaults to current locale)
 * @returns Translated string or fallback
 */
export const t = (key: string, localeOverride?: Language, params?: TranslationParams): string => {
  return formatTranslation(resolveTranslation(key, localeOverride), params);
};

/**
 * Source-first translation helper.
 * Keeps the English source string at the callsite while still using locale keys.
 */
export function td(key: string, defaultValue: string): string;
export function td(key: string, defaultValue: string, params: TranslationParams): string;
export function td(key: string, defaultValue: string, localeOverride: Language): string;
export function td(key: string, defaultValue: string, localeOverride: Language, params: TranslationParams): string;
export function td(key: string, defaultValue: string, localeOrParams?: Language | TranslationParams, params?: TranslationParams): string;
export function td(
  key: string,
  defaultValue: string,
  localeOrParams?: Language | TranslationParams,
  params?: TranslationParams,
): string {
  const parsed = parseTranslationArgs(localeOrParams, params);
  return formatTranslation(resolveTranslation(key, parsed.localeOverride, defaultValue), parsed.params);
}

/**
 * Initialize locale from localStorage
 * Call this during app initialization
 */
export const initLocale = (): Language => {
  if (typeof window === "undefined") {
    return "en";
  }

  try {
    const stored = window.localStorage.getItem(LANGUAGE_PREF_KEY);
    if (isLanguage(stored)) {
      setLocaleSignal(stored);
      if (typeof document !== "undefined") {
        document.documentElement.setAttribute("lang", stored);
      }
      return stored;
    }
  } catch (e) {
    console.warn("Failed to read language preference:", e);
  }

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", "en");
  }

  return "en";
};
