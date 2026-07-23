import { describe, expect, test } from "bun:test";

import {
  normalizePromptTraceId,
  promptDebugEnabled,
  promptTraceId,
  resolvePromptDebugSetting,
} from "./openwork-debug-log.js";

describe("prompt debug enablement", () => {
  const setting = (
    level: "off" | "metadata" | "exact",
    source: ReturnType<typeof resolvePromptDebugSetting>["source"],
  ) => ({ enabled: level !== "off", exact: level === "exact", level, source });

  test("is off by default", () => {
    expect(resolvePromptDebugSetting({})).toEqual(setting("off", "default"));
    expect(promptDebugEnabled({})).toBe(false);
  });

  test("uses recognized dev-mode values only when the explicit override is absent", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(resolvePromptDebugSetting({ OPENWORK_DEV_MODE: value })).toEqual(setting("metadata", "OPENWORK_DEV_MODE"));
    }
    for (const value of ["0", "false", "NO", " off "]) {
      expect(resolvePromptDebugSetting({ OPENWORK_DEV_MODE: value })).toEqual(setting("off", "OPENWORK_DEV_MODE"));
    }
    expect(resolvePromptDebugSetting({ OPENWORK_DEV_MODE: "surprising-value" })).toEqual(setting("off", "OPENWORK_DEV_MODE_INVALID"));
  });

  test("uses the desktop preference before the process dev-mode fallback", () => {
    expect(resolvePromptDebugSetting({
      OPENWORK_DESKTOP_DEV_MODE: "1",
      OPENWORK_DEV_MODE: "0",
    })).toEqual(setting("metadata", "OPENWORK_DESKTOP_DEV_MODE"));
    expect(resolvePromptDebugSetting({
      OPENWORK_DESKTOP_DEV_MODE: "0",
      OPENWORK_DEV_MODE: "1",
    })).toEqual(setting("off", "OPENWORK_DESKTOP_DEV_MODE"));
    expect(resolvePromptDebugSetting({
      OPENWORK_DESKTOP_DEV_MODE: "invalid",
      OPENWORK_DEV_MODE: "1",
    })).toEqual(setting("off", "OPENWORK_DESKTOP_DEV_MODE"));
    expect(resolvePromptDebugSetting({
      OPENWORK_DESKTOP_PROMPT_LOG: "1",
      OPENWORK_DESKTOP_DEV_MODE: "1",
    })).toEqual(setting("exact", "OPENWORK_DESKTOP_PROMPT_LOG"));
  });

  test("lets a nonblank explicit value override dev mode and fails closed when invalid", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(resolvePromptDebugSetting({
        OPENWORK_PROMPT_LOG: value,
        OPENWORK_DEV_MODE: "0",
      })).toEqual(setting("exact", "OPENWORK_PROMPT_LOG"));
    }
    for (const value of ["0", "false", "NO", " off "]) {
      expect(resolvePromptDebugSetting({
        OPENWORK_PROMPT_LOG: value,
        OPENWORK_DEV_MODE: "1",
      })).toEqual(setting("off", "OPENWORK_PROMPT_LOG"));
    }
    expect(resolvePromptDebugSetting({
      OPENWORK_PROMPT_LOG: "invalid",
      OPENWORK_DESKTOP_DEV_MODE: "1",
      OPENWORK_DEV_MODE: "1",
    })).toEqual(setting("off", "OPENWORK_PROMPT_LOG_INVALID"));
  });

  test("lets the explicit override win over the desktop preference", () => {
    expect(resolvePromptDebugSetting({
      OPENWORK_PROMPT_LOG: "0",
      OPENWORK_DESKTOP_DEV_MODE: "1",
    })).toEqual(setting("off", "OPENWORK_PROMPT_LOG"));
    expect(resolvePromptDebugSetting({
      OPENWORK_PROMPT_LOG: "1",
      OPENWORK_DESKTOP_DEV_MODE: "0",
    })).toEqual(setting("exact", "OPENWORK_PROMPT_LOG"));
  });

  test("treats a blank explicit value as absent and falls back to dev mode", () => {
    expect(resolvePromptDebugSetting({
      OPENWORK_PROMPT_LOG: "   ",
      OPENWORK_DEV_MODE: "1",
    })).toEqual(setting("metadata", "OPENWORK_DEV_MODE"));
  });

  test("uses the three-level observability control as the authoritative source", () => {
    expect(resolvePromptDebugSetting({
      OPENWORK_OBSERVABILITY: "metadata",
      OPENWORK_PROMPT_LOG: "1",
    })).toEqual(setting("metadata", "OPENWORK_OBSERVABILITY"));
    expect(resolvePromptDebugSetting({
      OPENWORK_OBSERVABILITY: "exact",
      OPENWORK_PROMPT_LOG: "0",
    })).toEqual(setting("exact", "OPENWORK_OBSERVABILITY"));
    expect(resolvePromptDebugSetting({
      OPENWORK_OBSERVABILITY: "off",
      OPENWORK_DESKTOP_DEV_MODE: "1",
    })).toEqual(setting("off", "OPENWORK_OBSERVABILITY"));
    expect(resolvePromptDebugSetting({
      OPENWORK_OBSERVABILITY: "verbose",
      OPENWORK_PROMPT_LOG: "1",
    })).toEqual(setting("off", "OPENWORK_OBSERVABILITY_INVALID"));
  });

  test("correlates one transform object without deriving an id from its content", () => {
    const first = { sessionID: "private-session", messageID: "private-message" };
    const second = { sessionID: "private-session", messageID: "private-message" };
    const firstId = promptTraceId(first);

    expect(firstId).toMatch(/^pt_[a-z0-9]{12}$/);
    expect(promptTraceId(first)).toBe(firstId);
    expect(promptTraceId(second)).not.toBe(firstId);
    expect(firstId).not.toContain("private");
    expect(promptTraceId(null)).toBe("pt_unscoped");
  });

  test("validates trace ids before server-side log correlation", () => {
    expect(normalizePromptTraceId(" PT_00000A ")).toBe("pt_00000a");
    expect(normalizePromptTraceId("pt_unscoped")).toBe("pt_unscoped");
    expect(normalizePromptTraceId("private-session-id")).toBeNull();
    expect(normalizePromptTraceId("pt_123456\nforged=true")).toBeNull();
  });
});
