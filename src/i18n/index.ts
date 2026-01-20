import { createSignal, createRoot, createMemo } from "solid-js";
import en from "./locales/en";
import zh from "./locales/zh";
import ja from "./locales/ja";
import ko from "./locales/ko";
import es from "./locales/es";
import ar from "./locales/ar";
import zhTw from "./locales/zh-tw";
import zhHk from "./locales/zh-hk";
import pt from "./locales/pt";

export type Locale = "en" | "zh" | "ja" | "ko" | "es" | "ar" | "zh-tw" | "zh-hk" | "pt";
export type Language = Locale;

// Translation dictionaries
const translations = {
  en,
  zh,
  ja,
  ko,
  es,
  ar,
  "zh-tw": zhTw,
  "zh-hk": zhHk,
  pt,
};

// Create a reactive locale signal with root-level persistence
const [locale, setLocale] = createRoot(() => createSignal<Locale>("en"));

// Reactive translation function that returns a function
// The returned function takes a key and returns the translated string
export const createTranslations = () => {
  // Get the current translations dict reactively
  const dict = createMemo(() => {
    const loc = locale();
    return translations[loc] ?? translations.en;
  });

  // Return a function that translates a key
  // This function will reactively update when locale changes
  return (key: string, params?: Record<string, string | number>) => {
    const currentDict = dict();
    let text = currentDict[key as keyof typeof currentDict] ?? key;

    // Simple parameter interpolation
    if (params) {
      Object.entries(params).forEach(([param, value]) => {
        text = text.replace(`{${param}}`, String(value));
      });
    }

    return text;
  };
};

// Non-reactive translation function (for use outside components)
export const t = (key: string, localeOverride?: Locale): string => {
  const loc = localeOverride ?? locale();
  const dict = translations[loc] ?? translations.en;
  return dict[key as keyof typeof dict] ?? key;
};

// Reactive locale accessors
export const useLocale = () => locale;
export const setAppLocale = (loc: Locale) => setLocale(loc);
