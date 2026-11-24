import en from "./locales/en";
import ja from "./locales/ja";
import zh from "./locales/zh";
import vi from "./locales/vi";
import ptBR from "./locales/pt-BR";
import th from "./locales/th";
import fr from "./locales/fr";
import ca from "./locales/ca";
import es from "./locales/es";
import ru from "./locales/ru";
import it from "./locales/it";
export const LANGUAGE_PREF_KEY = "openwork.language";

export type Language = "en" | "ja" | "zh" | "vi" | "pt-BR" | "th" | "fr" | "ca" | "es" | "ru" | "it";
export type Locale = Language;

export const LANGUAGES: Language[] = ["en", "ja", "zh", "vi", "pt-BR", "th", "fr", "ca", "es", "ru", "it"];

export const LANGUAGE_OPTIONS = [
  { value: "en" as Language, label: "English", nativeName: "English" },
  { value: "ja" as Language, label: "Japanese", nativeName: "日本語" },
  { value: "zh" as Language, label: "Chinese (Simplified)", nativeName: "简体中文" },
  { value: "vi" as Language, label: "Vietnamese", nativeName: "Tiếng Việt" },
  { value: "pt-BR" as Language, label: "Portuguese (BR)", nativeName: "Português (BR)" },
  { value: "th" as Language, label: "Thai", nativeName: "ไทย" },
  { value: "fr" as Language, label: "French", nativeName: "Français" },
  { value: "ca" as Language, label: "Catalan", nativeName: "Català" },
  { value: "es" as Language, label: "Spanish", nativeName: "Español" },
  { value: "ru" as Language, label: "Russian", nativeName: "Русский" },
  { value: "it" as Language, label: "Italian", nativeName: "Italiano" },
] as const;

const PLURAL_SUFFIX_EMPTY_LANGUAGES = new Set<Language>(["ja", "zh", "th"]);

export const pluralSuffix = (locale: Language, count: number): string => {
  if (PLURAL_SUFFIX_EMPTY_LANGUAGES.has(locale)) {
    return "";
  }

  return count === 1 ? "" : "s";
};

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
  ru,
  it,
};

export const isLanguage = (value: unknown): value is Language => {
  return typeof value === "string" && LANGUAGES.includes(value as Language);
};

let localeValue: Language = "en";

export const currentLocale = (): Language => locale();
function locale(): Language {
  return localeValue;
}

export const setLocale = (newLocale: Language) => {
  if (!isLanguage(newLocale)) {
    console.warn(`Invalid locale: ${newLocale}, falling back to "en"`);
    newLocale = "en";
  }

  localeValue = newLocale;

  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", newLocale);
  }

  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(LANGUAGE_PREF_KEY, newLocale);
    } catch (e) {
      console.warn("Failed to persist language preference:", e);
    }
  }
};

const lookupEntry = (loc: Language, candidateKey: string): string | null => {
  if (TRANSLATIONS[loc]?.[candidateKey]) return TRANSLATIONS[loc][candidateKey];
  if (loc !== "en" && TRANSLATIONS.en?.[candidateKey]) return TRANSLATIONS.en[candidateKey];
  return null;
};

const pluralRulesByLanguage: Record<Language, Intl.PluralRules> = {
  en: new Intl.PluralRules("en"),
  ja: new Intl.PluralRules("ja"),
  zh: new Intl.PluralRules("zh"),
  vi: new Intl.PluralRules("vi"),
  "pt-BR": new Intl.PluralRules("pt-BR"),
  th: new Intl.PluralRules("th"),
  fr: new Intl.PluralRules("fr"),
  ca: new Intl.PluralRules("ca"),
  es: new Intl.PluralRules("es"),
  ru: new Intl.PluralRules("ru"),
  it: new Intl.PluralRules("it"),
};
const pluralRule = (loc: Language, count: number): Intl.LDMLPluralRule => {
  return pluralRulesByLanguage[loc].select(count);
};

const resolvePluralKey = (loc: Language, key: string, count: number): string => {
  const candidates: string[] = [];
  if (count === 0) candidates.push(`${key}_zero`);
  candidates.push(`${key}_${pluralRule(loc, count)}`, `${key}_other`, key);

  for (const candidate of candidates) {
    if (lookupEntry(loc, candidate) !== null) return candidate;
  }
  return key;
};

type TranslationParams = Record<string, string | number> & { lng?: Language };

export const t = (
  key: string,
  paramsOrLocale?: TranslationParams | Language,
  legacyParams?: Record<string, string | number>,
): string => {
  const params = legacyParams ?? (typeof paramsOrLocale === "string" ? undefined : paramsOrLocale);
  const loc: Language = typeof paramsOrLocale === "string"
    ? paramsOrLocale
    : isLanguage(params?.lng)
      ? params.lng
      : locale();

  const lookupKey =
    typeof params?.count === "number" ? resolvePluralKey(loc, key, params.count) : key;

  const result = lookupEntry(loc, lookupKey);
  if (result === null) return key;

  if (!params) return result;

  let out = result;
  for (const [k, v] of Object.entries(params)) {
    if (k === "lng") continue;
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
};

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
