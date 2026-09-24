import { describe, expect, test } from "bun:test";
import { FAST_DEFAULT_VARIANT, fastVariantId } from "@openwork/types/cloud-model-fast";

import {
  chordFromEvent,
  chordProblem,
  formatChord,
  nextFreeChord,
  resolveShortcutOs,
} from "../src/react-app/domains/shortcuts/shortcut-keys";
import {
  parseStoredShortcuts,
  shortcutForKeys,
  upsertShortcut,
  type Shortcut,
} from "../src/react-app/domains/shortcuts/model-shortcuts-store";
import { decideModelShortcut, resolveShortcutVariant } from "../src/react-app/domains/shortcuts/resolve-model-shortcut";
import { switchedNoticeCopy, unavailableNoticeCopy } from "../src/react-app/domains/shortcuts/model-shortcut-messages";
import { shortcutRowState } from "../src/react-app/domains/shortcuts/shortcut-row-state";

const keyEvent = (overrides: Partial<Parameters<typeof chordFromEvent>[0]> = {}) => ({
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  key: "1",
  code: "Digit1",
  ...overrides,
});

const shortcut = (overrides: Partial<Shortcut> & { action?: Partial<Shortcut["action"]> } = {}): Shortcut => ({
  id: overrides.id ?? "sc_1",
  keys: overrides.keys ?? "Mod+Alt+1",
  action: {
    type: "model.switch",
    providerID: "openai",
    modelID: "gpt-5",
    effort: null,
    fast: false,
    ...overrides.action,
  },
});

describe("shortcut keys", () => {
  test("one saved chord means Command on macOS and Control elsewhere", () => {
    expect(resolveShortcutOs("macos", "")).toBe("macos");
    expect(resolveShortcutOs(undefined, "MacIntel")).toBe("macos");
    expect(resolveShortcutOs("windows", "MacIntel")).toBe("other");
    expect(chordFromEvent(keyEvent({ metaKey: true, altKey: true, key: "¡" }), "macos")).toBe("Mod+Alt+1");
    expect(chordFromEvent(keyEvent({ ctrlKey: true, altKey: true }), "other")).toBe("Mod+Alt+1");
    expect(chordFromEvent(keyEvent({ ctrlKey: true, altKey: true }), "macos")).toBe("Ctrl+Alt+1");
    expect(formatChord("Mod+Alt+1", "macos")).toBe("⌥⌘1");
    expect(formatChord("Mod+Alt+1", "other")).toBe("Ctrl+Alt+1");
    expect(formatChord("Ctrl+Shift+Mod+K", "macos")).toBe("⌃⇧⌘K");
  });

  test("bare modifiers and AltGr characters are never shortcuts", () => {
    expect(chordFromEvent(keyEvent({ altKey: true, key: "Alt", code: "AltLeft" }), "other")).toBeNull();
    expect(chordFromEvent(keyEvent({ ctrlKey: true, altKey: true, key: "{", code: "Digit7", getModifierState: (key) => key === "AltGraph" }), "other")).toBeNull();
  });

  test("a model shortcut needs Cmd/Ctrl plus Option/Alt or Shift and cannot take a built-in chord", () => {
    expect(chordProblem("Mod+1", "macos")).toEqual({ kind: "needs_modifier" });
    expect(chordProblem("Alt+1", "macos")).toEqual({ kind: "needs_modifier" });
    expect(chordProblem("Mod+Alt+1", "macos")).toBeNull();
    expect(chordProblem("Mod+Shift+F", "macos")).toEqual({ kind: "built_in", label: "Search all conversations" });
    expect(chordProblem("Mod+Alt+T", "other")).toEqual({ kind: "built_in", label: "Cycle reasoning" });
    expect(chordProblem("Mod+Alt+T", "macos")).toBeNull();
  });

  test("the recorder suggests the next free Mod+Alt digit", () => {
    expect(nextFreeChord(new Set())).toBe("Mod+Alt+1");
    expect(nextFreeChord(new Set(["Mod+Alt+1", "Mod+Alt+2"]))).toBe("Mod+Alt+3");
  });
});

describe("shortcut store", () => {
  test("stored shortcuts survive bad entries and never share keys", () => {
    const parsed = parseStoredShortcuts({
      version: 1,
      shortcuts: [
        shortcut(),
        { id: "bad", keys: "Mod+Alt+2", action: { type: "model.switch", providerID: "", modelID: "x", effort: null, fast: false } },
        shortcut({ id: "sc_dup", keys: "Mod+Alt+1" }),
        { id: "future", keys: "Mod+Alt+3", action: { type: "browser.open", url: "https://example.com" } },
      ],
    });
    expect(parsed.map((entry) => entry.id)).toEqual(["sc_1"]);
    expect(parseStoredShortcuts("nonsense")).toEqual([]);
  });

  test("reassigning a key replaces the old owner; one shortcut per model", () => {
    const first = shortcut();
    const second = shortcut({ id: "sc_2", keys: "Mod+Alt+2", action: { modelID: "gpt-5-mini" } });
    const reassigned = upsertShortcut([first, second], { ...second, keys: "Mod+Alt+1" });
    expect(reassigned.map((entry) => entry.id)).toEqual(["sc_2"]);
    const edited = upsertShortcut([first, second], shortcut({ id: "sc_new", keys: "Mod+Alt+5", action: { effort: "high" } }));
    expect(edited.map((entry) => `${entry.id}:${entry.keys}:${entry.action.effort}`)).toEqual(["sc_new:Mod+Alt+5:high", "sc_2:Mod+Alt+2:null"]);
    expect(shortcutForKeys(edited, "Mod+Alt+2")?.id).toBe("sc_2");
  });

  test("editing a shortcut's Fast preference keeps its key and position", () => {
    const first = shortcut();
    const second = shortcut({ id: "sc_2", keys: "Mod+Alt+2", action: { modelID: "gpt-5-mini" } });
    const edited = upsertShortcut([first, second], shortcut({ action: { fast: true } }));
    expect(edited.map((entry) => `${entry.id}:${entry.keys}:${entry.action.fast}`)).toEqual(["sc_1:Mod+Alt+1:true", "sc_2:Mod+Alt+2:false"]);
  });
});

describe("pressing a model shortcut", () => {
  const fastModel = { behaviorOptions: [
    { value: null }, { value: "high" }, { value: FAST_DEFAULT_VARIANT }, { value: fastVariantId("high") },
  ] };
  const reasoningModel = { behaviorOptions: [{ value: null }, { value: "low" }, { value: "high" }] };
  const plainModel = { behaviorOptions: [{ value: null }] };
  const current = { model: { providerID: "anthropic", modelID: "claude" }, variant: null };
  const available = { status: "available" as const };

  test("Fast is applied when offered and skipped, not blocking, when it is not", () => {
    expect(resolveShortcutVariant(fastModel.behaviorOptions.map((entry) => entry.value), "high", true)).toMatchObject({
      variant: fastVariantId("high"), effort: "high", fastApplied: true, fastSkipped: false,
    });
    expect(resolveShortcutVariant(fastModel.behaviorOptions.map((entry) => entry.value), null, true).variant).toBe(FAST_DEFAULT_VARIANT);
    expect(resolveShortcutVariant(reasoningModel.behaviorOptions.map((entry) => entry.value), "high", true)).toMatchObject({
      variant: "high", fastApplied: false, fastSkipped: true, effortSkipped: false,
    });
    expect(resolveShortcutVariant(plainModel.behaviorOptions.map((entry) => entry.value), "high", false)).toMatchObject({
      variant: null, effortSkipped: true,
    });
  });

  test("an unavailable model never switches and keeps its reason", () => {
    for (const reason of ["provider_blocked", "provider_not_connected", "model_missing"] as const) {
      expect(decideModelShortcut({ action: shortcut().action, option: fastModel, availability: { status: "unavailable", reason }, current }))
        .toEqual({ kind: "unavailable", reason });
    }
    expect(decideModelShortcut({ action: shortcut().action, option: null, availability: available, current }))
      .toEqual({ kind: "unavailable", reason: "model_missing" });
  });

  test("a catalog that is still loading is pending, never unavailable", () => {
    expect(decideModelShortcut({ action: shortcut().action, option: null, availability: { status: "pending" }, current }))
      .toEqual({ kind: "pending" });
  });

  test("pressing the key for the active model and level does nothing", () => {
    const action = shortcut({ action: { effort: "high" } }).action;
    expect(decideModelShortcut({ action, option: reasoningModel, availability: available, current: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "high" } }))
      .toEqual({ kind: "already_active" });
    expect(decideModelShortcut({ action, option: reasoningModel, availability: available, current: { model: { providerID: "openai", modelID: "gpt-5" }, variant: "low" } }))
      .toMatchObject({ kind: "switch", variant: "high" });
  });
});

describe("notice copy", () => {
  test("success names the model, level and Fast; skipped Fast says standard speed", () => {
    expect(switchedNoticeCopy({ modelTitle: "GPT-5", effortLabel: "High", fastApplied: true, fastSkipped: false, effortSkipped: false, requestedEffortLabel: "High" }))
      .toMatchObject({ tone: "success", title: "Switched to GPT-5", detail: "high reasoning, Fast", fast: true });
    expect(switchedNoticeCopy({ modelTitle: "Kimi K2", effortLabel: null, fastApplied: false, fastSkipped: true, effortSkipped: false, requestedEffortLabel: null }))
      .toMatchObject({ tone: "info", detail: "at standard speed. Fast isn't offered right now." });
  });

  test("each unavailable reason offers one fix; blocked is neutral, not an error", () => {
    const disconnected = unavailableNoticeCopy({ modelTitle: "Gemini 2.5 Pro", providerName: "Google", reason: "provider_not_connected" });
    expect(disconnected).toMatchObject({ tone: "warning", title: "Gemini 2.5 Pro isn't available", detail: "Google is disconnected." });
    expect(disconnected.actions.find((action) => action.primary)?.label).toBe("Reconnect Google");
    expect(unavailableNoticeCopy({ modelTitle: "Zen", providerName: null, reason: "provider_blocked" }).tone).toBe("blocked");
    expect(unavailableNoticeCopy({ modelTitle: "Old", providerName: "Acme", reason: "model_missing" }).tone).toBe("error");
  });
});

describe("settings row state", () => {
  const catalog = {
    all: [{ id: "openai", name: "OpenAI" }, { id: "google", name: "Google" }],
    connected: [{ id: "openai", models: { "gpt-5": { name: "GPT-5" } } }],
  };

  test("rows report the same reasons as the key press", () => {
    expect(shortcutRowState({ providerID: "openai", modelID: "gpt-5", blocked: false, catalog })).toEqual({ kind: "available" });
    expect(shortcutRowState({ providerID: "openai", modelID: "gone", blocked: false, catalog })).toEqual({ kind: "model_missing", providerName: "OpenAI" });
    expect(shortcutRowState({ providerID: "google", modelID: "gemini", blocked: false, catalog })).toEqual({ kind: "provider_disconnected", providerName: "Google" });
    expect(shortcutRowState({ providerID: "openai", modelID: "gpt-5", blocked: true, catalog })).toEqual({ kind: "blocked" });
    expect(shortcutRowState({ providerID: "openai", modelID: "gpt-5", blocked: false, catalog: null })).toEqual({ kind: "pending" });
  });
});
