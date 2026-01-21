import { createSignal, createRoot } from "solid-js";
import en from "./locales/en";
import zh from "./locales/zh";
import { LANGUAGE_PREF_KEY } from "../app/constants";

/**
 * Supported languages - only en and zh for initial PR
 */
export type Language = "en" | "zh";
export type Locale = Language;

/**
 * All supported languages - single source of truth
 */
export const LANGUAGES: Language[] = ["en", "zh"];

/**
 * Language options for UI - single source of truth
 */
export const LANGUAGE_OPTIONS = [
  { value: "en" as Language, label: "English", nativeName: "English" },
  { value: "zh" as Language, label: "简体中文", nativeName: "简体中文" },
] as const;

/**
 * Translation maps
 */
const TRANSLATIONS: Record<Language, Record<string, string>> = {
  en,
  zh,
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
export const t = (key: string, localeOverride?: Language): string => {
  const loc = localeOverride ?? locale();

  // Try target language first
  if (TRANSLATIONS[loc]?.[key]) {
    return TRANSLATIONS[loc][key];
  }

  // Fallback to English
  if (loc !== "en" && TRANSLATIONS.en?.[key]) {
    return TRANSLATIONS.en[key];
  }

  // Final fallback to key itself (prevents raw keys from showing in UI)
  return key;
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
      return stored;
    }
  } catch (e) {
    console.warn("Failed to read language preference:", e);
  }

  return "en";
};
