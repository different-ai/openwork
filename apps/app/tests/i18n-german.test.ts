import { afterEach, describe, expect, test } from "bun:test";

import de from "../src/i18n/locales/de";
import en from "../src/i18n/locales/en";
import {
  LANGUAGE_OPTIONS,
  LANGUAGES,
  currentLocale,
  initLocale,
  isLanguage,
  setLocale,
  t,
} from "../src/i18n";

const placeholders = (value: string): string[] => value.match(/\{[^{}]+\}/g)?.sort() ?? [];
const protectedTerms = ["Skill", "Plugin", "Command", "Session", "Worker"];

describe("German translations", () => {
  afterEach(() => setLocale("en"));

  test("matches the complete English catalog structure", () => {
    const german: Record<string, string> = de;
    expect(Object.keys(de)).toEqual(Object.keys(en));
    expect(Object.values(de).every((value) => value.trim().length > 0)).toBe(true);

    for (const [key, englishValue] of Object.entries(en)) {
      const germanValue = german[key];
      expect(placeholders(germanValue)).toEqual(placeholders(englishValue));
      expect(germanValue.split("\n")).toHaveLength(englishValue.split("\n").length);
      for (const term of protectedTerms) {
        if (new RegExp(`\\b${term}s?\\b`, "i").test(englishValue)) {
          expect(
            new RegExp(`\\b${term}s?\\b`, "i").test(germanValue),
            `${key} must preserve ${term}`,
          ).toBe(true);
        }
      }
    }
  });

  test("registers German by its native name", () => {
    expect(LANGUAGES).toContain("de");
    expect(LANGUAGE_OPTIONS).toContainEqual({ value: "de", label: "Deutsch", nativeName: "Deutsch" });
    expect(isLanguage("de")).toBe(true);
  });

  test("translates, interpolates, pluralizes, and returns unknown keys safely", () => {
    expect(t("settings.language", "de")).toBe("Sprache");
    expect(t("join_org.server_saved", { lng: "de", host: "openwork.example" })).toBe(
      "Mit openwork.example verbunden. Melden Sie sich an, um fortzufahren.",
    );
    expect(t("account.mcp_connected", { lng: "de", count: 1 })).toBe("1 MCP-Server");
    expect(t("account.mcp_connected", { lng: "de", count: 2 })).toBe("2 MCP-Server");
    expect(t("missing.translation", "de")).toBe("missing.translation");
  });

  test("uses concise German copy on the visible primary paths", () => {
    expect(t("welcome.use_without_cloud", "de")).toBe("Ohne Cloud verwenden");
    expect(t("session.empty_title", "de")).toBe("Was möchten Sie erledigen?");
    expect(t("dashboard.close_settings", "de")).toBe("Einstellungen schließen");
    expect(t("settings.theme_title", "de")).toBe("Design");
    expect(t("settings.tab_recovery", "de")).toBe("Wiederherstellung");
    expect(t("settings.environment.applying", "de")).toBe("Wird angewendet…");
    expect(t("models.change", "de")).toBe("Modell wechseln");
    expect(t("models.your_api_keys", "de")).toBe("Eigene API-Schlüssel");
  });

  test("uses Germany-specific suggestions with natural du-form prompts", () => {
    expect(t("session.suggestion_spreadsheet_title", "de")).toBe("CSV für Excel erstellen");
    expect(t("session.suggestion_web_desc", "de")).toContain("Kleinanzeigen");
    expect(t("session.suggestion_spreadsheet_prompt", "de").startsWith("Erstelle eine CSV-Datei")).toBe(true);
    expect(t("session.suggestion_document_prompt", "de")).toContain("Frag mich zuerst");
    expect(t("session.suggestion_web_prompt", "de")).toContain("Zeig mir fünf passende Angebote");
    expect(t("session.suggestion_week_prompt", "de")).not.toContain("Sie");
  });

  test("persists and restores German while updating the document language", () => {
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const storage = new Map<string, string>();
    const attributes = new Map<string, string>();
    try {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
        } },
      });
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { documentElement: { setAttribute: (key: string, value: string) => attributes.set(key, value) } },
      });

      setLocale("de");
      expect(storage.get("openwork.language")).toBe("de");
      expect(attributes.get("lang")).toBe("de");
      setLocale("en");
      storage.set("openwork.language", "de");
      expect(initLocale()).toBe("de");
      expect(currentLocale()).toBe("de");
      expect(attributes.get("lang")).toBe("de");
    } finally {
      Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, "document", { configurable: true, value: previousDocument });
    }
  });
});
