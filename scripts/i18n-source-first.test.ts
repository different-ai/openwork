import { beforeEach, describe, expect, test } from "bun:test";

import { setLocale, t, td } from "../apps/app/src/i18n/index";

describe("source-first i18n helper", () => {
  beforeEach(() => {
    setLocale("en");
  });

  test("returns inline English defaults for the English locale", () => {
    expect(td("config.server_url_input_label", "OpenWork server URL")).toBe("OpenWork server URL");
  });

  test("prefers translated locale values when present", () => {
    setLocale("pt-BR");
    expect(td("config.server_url_input_label", "OpenWork server URL")).toBe("URL do servidor OpenWork");
  });

  test("accepts locale override as the third argument", () => {
    expect(td("config.server_url_input_label", "OpenWork server URL", "ja")).toBe("OpenWorkサーバーURL");
  });

  test("falls back to inline English when locale entries are missing", () => {
    setLocale("th");
    expect(td("tests.missing_source_first_key", "Source-first fallback")).toBe("Source-first fallback");
  });

  test("formats placeholder params with inline English defaults", () => {
    expect(td("tests.greeting", "Hello {name}", { name: "Jan" })).toBe("Hello Jan");
  });

  test("accepts locale override before placeholder params", () => {
    expect(td("skills.trigger_label", "Trigger: {trigger}", "pt-BR", { trigger: "build" })).toBe("Gatilho: build");
  });

  test("keeps the original key-first helper behavior intact", () => {
    expect(t("config.server_url_input_label", "pt-BR")).toBe("URL do servidor OpenWork");
  });
});
