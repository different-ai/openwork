import { createSignal, createRoot } from "solid-js";
import en from "./locales/en";
import ja from "./locales/ja";
import zh from "./locales/zh";
import vi from "./locales/vi";
import ptBR from "./locales/pt-BR";
import { LANGUAGE_PREF_KEY } from "../app/constants";

/**
 * Supported languages
 */
export type Language = "en" | "ja" | "zh" | "vi" | "pt-BR";
export type Locale = Language;

/**
 * All supported languages - single source of truth
 */
export const LANGUAGES: Language[] = ["en", "ja", "zh", "vi", "pt-BR"];

/**
 * Language options for UI - single source of truth
 */
export const LANGUAGE_OPTIONS = [
  { value: "en" as Language, label: "English", nativeName: "English" },
  { value: "ja" as Language, label: "日本語", nativeName: "日本語" },
  { value: "zh" as Language, label: "简体中文", nativeName: "简体中文" },
  { value: "vi" as Language, label: "Vietnamese", nativeName: "Tiếng Việt" },
  { value: "pt-BR" as Language, label: "Portuguese (BR)", nativeName: "Português (BR)" },
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
export const t = (key: string, localeOverride?: Language, params?: Record<string, string | number>): string => {
  const loc = localeOverride ?? locale();

  // Try target language first
  let result: string;
  if (TRANSLATIONS[loc]?.[key]) {
    result = TRANSLATIONS[loc][key];
  } else if (loc !== "en" && TRANSLATIONS.en?.[key]) {
    // Fallback to English
    result = TRANSLATIONS.en[key];
  } else {
    // Final fallback to key itself (prevents raw keys from showing in UI)
    return key;
  }

  // Replace params if provided
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      result = result.replace(`{${k}}`, String(v));
    }
  }

  return result;
};

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
