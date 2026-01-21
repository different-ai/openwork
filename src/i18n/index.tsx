
import { createSignal, createContext, useContext, Accessor } from "solid-js";
import * as i18n from "@solid-primitives/i18n";
import { dict as en } from "./en";
import { dict as zh } from "./zh";
import { LOCALE_PREF_KEY } from "../app/constants";

export const dictionaries = { en, zh };
export type Locale = keyof typeof dictionaries;

// Helper to infer the true type of the translator
const _t = i18n.translator(() => en);
export type TranslatorType = typeof _t;


const I18nContext = createContext<[
    TranslatorType,
    { locale: Accessor<Locale>; setLocale: (l: Locale) => void }
]>();

function getStoredLocale(): Locale {
    if (typeof window === "undefined") return "en";
    try {
        const stored = window.localStorage.getItem(LOCALE_PREF_KEY);
        if (stored && stored in dictionaries) {
            return stored as Locale;
        }
    } catch {
        // ignore
    }
    return "en";
}

export function I18nProvider(props: { children: any }) {
    const [locale, _setLocale] = createSignal<Locale>(getStoredLocale());
    const dict = () => i18n.flatten(dictionaries[locale()]);
    const t = i18n.translator(dict);

    const setLocale = (l: Locale) => {
        _setLocale(l);
        try {
            window.localStorage.setItem(LOCALE_PREF_KEY, l);
        } catch {
            // ignore
        }
    };

    return (
        <I18nContext.Provider value={[t, { locale, setLocale }]} >
            {props.children}
        </I18nContext.Provider>
    );
}

export function useI18n() {
    const context = useContext(I18nContext);
    if (!context) throw new Error("useI18n must be used within I18nProvider");
    // Mimic the signature expected by App.tsx: [t, { locale }]
    // Note: We need to adapt setLocale to match the (l => ...) pattern if needed, 
    // currently App.tsx uses: locale(l => l === 'en' ? 'zh' : 'en') which looks like a signal setter.
    // We will expose the signal setter directly or a wrapper.
    const [t, { locale, setLocale }] = context;

    // Create a compatible locale accessor/setter 
    // that can be called as locale() to get, or locale(newValue) to set.
    // However, App.tsx usage `locale(l => ...)` implies it expects a standard SolidJS signal setter signature.
    const localeProxy: any = (arg?: any) => {
        if (arg === undefined) return locale();
        if (typeof arg === 'function') {
            setLocale(arg(locale()));
        } else {
            setLocale(arg);
        }
    };

    return [t as any, { locale: localeProxy }] as const;
}
