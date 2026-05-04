import en from "./locales/en";
import ja from "./locales/ja";
import zh from "./locales/zh";
import vi from "./locales/vi";
import ptBR from "./locales/pt-BR";
import th from "./locales/th";
import fr from "./locales/fr";
import ca from "./locales/ca";
import es from "./locales/es";
import { LANGUAGE_PREF_KEY } from "../app/constants";

/**
 * Supported languages
 */
export type Language = "en" | "ja" | "zh" | "vi" | "pt-BR" | "th" | "fr" | "ca" | "es";
export type Locale = Language;

/**
 * All supported languages - single source of truth
 */
export const LANGUAGES: Language[] = ["en", "ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es"];

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
  { value: "fr" as Language, label: "French", nativeName: "Français" },
  { value: "ca" as Language, label: "Català", nativeName: "Català" },
  { value: "es" as Language, label: "Español", nativeName: "Español" },
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
  fr,
  ca,
  es,
};

/**
 * Type guard to validate if a value is a Language
 * Replaces long chains like: value === "en" || value === "zh"
 */
export const isLanguage = (value: unknown): value is Language => {
  return typeof value === "string" && LANGUAGES.includes(value as Language);
};

let localeValue: Language = "en";

/**
 * Get current locale
 */
export const currentLocale = (): Language => locale();
function locale(): Language {
  return localeValue;
}

/**
 * Set locale and persist to localStorage
 */
export const setLocale = (newLocale: Language) => {
  if (!isLanguage(newLocale)) {
    console.warn(`Invalid locale: ${newLocale}, falling back to "en"`);
    newLocale = "en";
  }

  localeValue = newLocale;

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
 * Resolve a translation entry with the locale → English → null fallback chain.
 */
const lookupEntry = (loc: Language, candidateKey: string): string | null => {
  if (TRANSLATIONS[loc]?.[candidateKey]) return TRANSLATIONS[loc][candidateKey];
  if (loc !== "en" && TRANSLATIONS.en?.[candidateKey]) return TRANSLATIONS.en[candidateKey];
  return null;
};

const pluralRulesCache = new Map<Language, Intl.PluralRules>();
const pluralRule = (loc: Language, count: number): Intl.LDMLPluralRule => {
  let rules = pluralRulesCache.get(loc);
  if (!rules) {
    rules = new Intl.PluralRules(loc);
    pluralRulesCache.set(loc, rules);
  }
  return rules.select(count);
};

/**
 * Pick the right key variant for a count. Tries `${key}_zero` (only when count === 0),
 * then `${key}_${rule}` (e.g. `_one` / `_other`), then `${key}_other`, then the bare
 * key. Asian locales (no grammatical plural) define only the bare key and hit the
 * final step. Each candidate runs through the locale → English fallback so an
 * untranslated key still resolves to the English `_one` / `_other` variant.
 */
const resolvePluralKey = (loc: Language, key: string, count: number): string => {
  const candidates: string[] = [];
  if (count === 0) candidates.push(`${key}_zero`);
  candidates.push(`${key}_${pluralRule(loc, count)}`, `${key}_other`, key);

  for (const candidate of candidates) {
    if (lookupEntry(loc, candidate) !== null) return candidate;
  }
  return key;
};

/**
 * Translation function with fallback behavior.
 * - Locale fallback: target language → English → key itself.
 * - Plural fallback: when params include a numeric `count`, the lookup picks
 *   `${key}_one` / `${key}_other` (or `${key}_zero` when count === 0) per
 *   `Intl.PluralRules`, and falls back to the bare key when no variants exist.
 */
export const t = (key: string, params?: Record<string, string | number> & { lng?: Language }): string => {
  const loc = params?.lng ?? locale();

  const lookupKey =
    typeof params?.count === "number" ? resolvePluralKey(loc, key, params.count) : key;

  const result = lookupEntry(loc, lookupKey);
  if (result === null) return key;

  if (!params) return result;

  let out = result;
  for (const [k, v] of Object.entries(params)) {
    if (k === "lng") continue;
    out = out.replace(`{${k}}`, String(v));
  }
  return out;
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
      localeValue = stored;
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
