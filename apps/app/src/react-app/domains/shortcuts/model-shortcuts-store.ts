// User-defined shortcuts. v1 ships one action type, `model.switch`: a key that
// switches the focused conversation to a saved model, reasoning level and
// Fast preference. The action is a discriminated union so later actions
// (open browser, select connections, open a file, open a dashboard) can reuse
// the same list, recorder and failure notice.
//
// A shortcut is never removed because its model became unavailable; only the
// person removes or reassigns it.
import { z } from "zod";
import { create } from "zustand";

import type { ModelRef } from "@/app/types";

export const MODEL_SHORTCUTS_STORAGE_KEY = "openwork.shortcuts.v1";

const modelSwitchAction = z.object({
  type: z.literal("model.switch"),
  providerID: z.string().trim().min(1),
  modelID: z.string().trim().min(1),
  /** Standard reasoning variant id; null is the provider default. */
  effort: z.string().min(1).nullable(),
  /** Preference only: applied when the model offers Fast, skipped otherwise. */
  fast: z.boolean(),
  /** Last known names, so a shortcut to a model that disappeared still reads well. */
  modelTitle: z.string().optional(),
  providerName: z.string().optional(),
});

const shortcutAction = z.discriminatedUnion("type", [modelSwitchAction]);

const shortcutSchema = z.object({
  id: z.string().min(1),
  keys: z.string().min(1),
  action: shortcutAction,
});

export type ModelSwitchAction = z.infer<typeof modelSwitchAction>;
export type Shortcut = z.infer<typeof shortcutSchema>;

export function shortcutModelRef(shortcut: Shortcut): ModelRef {
  return { providerID: shortcut.action.providerID, modelID: shortcut.action.modelID };
}

/** Parse stored shortcuts, dropping only malformed entries and duplicate keys. */
export function parseStoredShortcuts(raw: unknown): Shortcut[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const list = Reflect.get(raw, "shortcuts");
  if (!Array.isArray(list)) return [];
  const seenKeys = new Set<string>();
  const seenIds = new Set<string>();
  const result: Shortcut[] = [];
  for (const entry of list) {
    const parsed = shortcutSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (seenKeys.has(parsed.data.keys) || seenIds.has(parsed.data.id)) continue;
    seenKeys.add(parsed.data.keys);
    seenIds.add(parsed.data.id);
    result.push(parsed.data);
  }
  return result;
}

function readStoredShortcuts(): Shortcut[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_SHORTCUTS_STORAGE_KEY);
    return raw ? parseStoredShortcuts(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function writeStoredShortcuts(shortcuts: readonly Shortcut[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(MODEL_SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 1, shortcuts }));
  } catch {
    // Storage can be full or disabled; the in-memory list still works.
  }
}

/**
 * Insert or replace one shortcut. A shortcut that already owns the same keys
 * is replaced (the person confirmed "Reassign"); the same model may only have
 * one shortcut, so saving a model again edits its existing entry.
 */
export function upsertShortcut(shortcuts: readonly Shortcut[], next: Shortcut): Shortcut[] {
  const sameModel = (entry: Shortcut) =>
    entry.action.providerID === next.action.providerID && entry.action.modelID === next.action.modelID;
  const existingIndex = shortcuts.findIndex((entry) => entry.id === next.id || sameModel(entry));
  const result = shortcuts
    .map((entry, index) => (index === existingIndex ? next : entry))
    .filter((entry, index) => index === existingIndex
      || (entry.id !== next.id && !sameModel(entry) && entry.keys !== next.keys));
  return existingIndex === -1 ? [...result, next] : result;
}

export function shortcutForKeys(shortcuts: readonly Shortcut[], keys: string) {
  return shortcuts.find((entry) => entry.keys === keys) ?? null;
}

export function shortcutForModel(shortcuts: readonly Shortcut[], model: ModelRef) {
  return shortcuts.find((entry) => entry.action.providerID === model.providerID && entry.action.modelID === model.modelID) ?? null;
}

let idCounter = 0;
export function createShortcutId() {
  idCounter += 1;
  return `sc_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

type ModelShortcutsStore = {
  shortcuts: Shortcut[];
  save: (shortcut: Shortcut) => void;
  remove: (id: string) => void;
};

export const useModelShortcutsStore = create<ModelShortcutsStore>((set) => ({
  shortcuts: readStoredShortcuts(),
  save: (shortcut) => set((state) => {
    const shortcuts = upsertShortcut(state.shortcuts, shortcut);
    writeStoredShortcuts(shortcuts);
    return { shortcuts };
  }),
  remove: (id) => set((state) => {
    const shortcuts = state.shortcuts.filter((entry) => entry.id !== id);
    writeStoredShortcuts(shortcuts);
    return { shortcuts };
  }),
}));

// Keep windows in sync: settings and chat can live in different renderer
// windows, and a shortcut saved in one must work in the other.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== MODEL_SHORTCUTS_STORAGE_KEY) return;
    useModelShortcutsStore.setState({ shortcuts: readStoredShortcuts() });
  });
}
