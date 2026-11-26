import { z } from "zod";
import { create } from "zustand";

type ShortcutOs = "macos" | "other";

export const ACTION_SHORTCUTS_STORAGE_KEY = "openwork.shortcuts.actions.v1";
export const APP_ACTION_EVENT = "openwork:app-action";

export const APP_ACTION_IDS = [
  "command-palette.toggle",
  "session.new",
  "session-search.open",
  "session.archive.toggle",
  "terminal.toggle",
  "sidebar.toggle",
  "panel.toggle",
  "browser.open",
  "dictation.toggle",
  "settings.computer",
] as const;

export type AppActionId = (typeof APP_ACTION_IDS)[number];

export type AppActionDefinition = {
  id: AppActionId;
  label: string;
  keywords: string[];
  defaultKeys: string | null;
  fixedKeys?: { chord: string; source: string };
};

export const APP_ACTIONS: readonly AppActionDefinition[] = [
  { id: "command-palette.toggle", label: "Command palette", keywords: ["cmd k", "search actions"], defaultKeys: "Mod+K" },
  { id: "session.new", label: "New session", keywords: ["new chat", "new task"], defaultKeys: "Mod+N" },
  { id: "session-search.open", label: "Search sessions", keywords: ["find sessions", "history"], defaultKeys: "Mod+Shift+F" },
  { id: "session.archive.toggle", label: "Archive session", keywords: ["archive", "unarchive", "done"], defaultKeys: "Mod+Shift+E" },
  { id: "terminal.toggle", label: "Show or hide terminal", keywords: ["terminal", "shell", "console"], defaultKeys: "Mod+J" },
  { id: "sidebar.toggle", label: "Show or hide left sidebar", keywords: ["sidebar", "left panel", "sessions list"], defaultKeys: null, fixedKeys: { chord: "Mod+B", source: "App menu" } },
  { id: "panel.toggle", label: "Show or hide right panel", keywords: ["right panel", "side panel", "files", "browser", "library"], defaultKeys: null },
  { id: "browser.open", label: "Open browser", keywords: ["browser", "web", "new tab", "website"], defaultKeys: null },
  { id: "dictation.toggle", label: "Start or stop dictation", keywords: ["microphone", "mic", "voice", "dictate", "speech", "talk"], defaultKeys: null },
  { id: "settings.computer", label: "Computer use settings", keywords: ["computer use", "control apps", "accessibility"], defaultKeys: null },
];

export function appActionDefinition(id: AppActionId): AppActionDefinition {
  const definition = APP_ACTIONS.find((entry) => entry.id === id);
  if (!definition) throw new Error(`Unknown app action ${id}`);
  return definition;
}

export type ShortcutTarget =
  | { type: "app"; actionId: AppActionId }
  | { type: "skill"; name: string };

const appActionId = z.enum(APP_ACTION_IDS);
const storedShape = z.object({
  overrides: z.record(z.string(), z.string().min(1).nullable()).default({}),
  skills: z.array(z.object({ id: z.string().min(1), name: z.string().trim().min(1), keys: z.string().min(1) })).default([]),
});

export type SkillShortcut = { id: string; name: string; keys: string };
export type ActionShortcutState = {
  overrides: Partial<Record<AppActionId, string | null>>;
  skills: SkillShortcut[];
};

export function parseActionShortcuts(raw: unknown): ActionShortcutState {
  const parsed = storedShape.safeParse(raw);
  if (!parsed.success) return { overrides: {}, skills: [] };
  const overrides: Partial<Record<AppActionId, string | null>> = {};
  for (const [id, keys] of Object.entries(parsed.data.overrides)) {
    const known = appActionId.safeParse(id);
    if (known.success) overrides[known.data] = keys;
  }
  const seen = new Set<string>();
  const skills = parsed.data.skills.filter((entry) => {
    if (seen.has(entry.keys) || seen.has(`id:${entry.id}`)) return false;
    seen.add(entry.keys);
    seen.add(`id:${entry.id}`);
    return true;
  });
  return { overrides, skills };
}

export function actionKeys(state: ActionShortcutState, id: AppActionId): string | null {
  const definition = appActionDefinition(id);
  return id in state.overrides ? state.overrides[id] ?? null : definition.defaultKeys;
}

export type ResolvedBindings = {
  byChord: Map<string, ShortcutTarget>;
  silenced: Set<string>;
};

export function resolveActionBindings(state: ActionShortcutState): ResolvedBindings {
  const byChord = new Map<string, ShortcutTarget>();
  const silenced = new Set<string>();
  for (const definition of APP_ACTIONS) {
    const keys = actionKeys(state, definition.id);
    if (definition.defaultKeys && keys !== definition.defaultKeys) silenced.add(definition.defaultKeys);
    if (keys && keys !== definition.defaultKeys) byChord.set(keys, { type: "app", actionId: definition.id });
  }
  for (const skill of state.skills) byChord.set(skill.keys, { type: "skill", name: skill.name });
  for (const chord of byChord.keys()) silenced.delete(chord);
  return { byChord, silenced };
}

const EDITING_KEYS = new Set(["A", "C", "V", "X", "Z", "Y", "Q", "W", "H", "M", "F", "R", "T", "L", "P", "S", "O", "=", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "Backspace", "Delete", "Enter", "Tab", "Escape"]);

export type ActionChordProblem =
  | { kind: "needs_modifier" }
  | { kind: "reserved" }
  | { kind: "taken"; label: string };

export function actionChordProblem(input: {
  chord: string;
  state: ActionShortcutState;
  takenElsewhere: ReadonlyArray<{ chord: string; label: string }>;
  ignore: { actionId?: AppActionId; skillId?: string };
}): ActionChordProblem | null {
  const parts = input.chord.split("+").filter(Boolean);
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts);
  if (!key || (!modifiers.has("Mod") && !modifiers.has("Ctrl"))) return { kind: "needs_modifier" };
  const onlyPrimary = !modifiers.has("Alt") && !modifiers.has("Shift");
  if (onlyPrimary && EDITING_KEYS.has(key)) return { kind: "reserved" };
  for (const definition of APP_ACTIONS) {
    if (definition.id === input.ignore.actionId) continue;
    if (actionKeys(input.state, definition.id) === input.chord || definition.fixedKeys?.chord === input.chord) {
      return { kind: "taken", label: definition.label };
    }
  }
  const skill = input.state.skills.find((entry) => entry.keys === input.chord && entry.id !== input.ignore.skillId);
  if (skill) return { kind: "taken", label: `/${skill.name}` };
  const other = input.takenElsewhere.find((entry) => entry.chord === input.chord);
  return other ? { kind: "taken", label: other.label } : null;
}

export function actionChordProblemMessage(problem: ActionChordProblem, os: ShortcutOs): string {
  switch (problem.kind) {
    case "needs_modifier":
      return os === "macos" ? "Use ⌘ or ⌃ with a key, like ⌥⌘P." : "Use Ctrl with a key, like Ctrl+Alt+P.";
    case "reserved":
      return "That key is used for editing or switching sessions. Add ⌥ or ⇧.";
    case "taken":
      return `Already used for ${problem.label}.`;
  }
}

function readStored(): ActionShortcutState {
  if (typeof window === "undefined") return { overrides: {}, skills: [] };
  try {
    const raw = window.localStorage.getItem(ACTION_SHORTCUTS_STORAGE_KEY);
    return raw ? parseActionShortcuts(JSON.parse(raw)) : { overrides: {}, skills: [] };
  } catch {
    return { overrides: {}, skills: [] };
  }
}

function writeStored(state: ActionShortcutState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTION_SHORTCUTS_STORAGE_KEY, JSON.stringify({ version: 1, overrides: state.overrides, skills: state.skills }));
  } catch {
    return;
  }
}

let skillCounter = 0;
export function createSkillShortcutId() {
  skillCounter += 1;
  return `sk_${Date.now().toString(36)}_${skillCounter.toString(36)}`;
}

type ActionShortcutsStore = ActionShortcutState & {
  setActionKeys: (id: AppActionId, keys: string | null) => void;
  resetAction: (id: AppActionId) => void;
  saveSkill: (skill: SkillShortcut) => void;
  removeSkill: (id: string) => void;
};

function persist(next: ActionShortcutState): ActionShortcutState {
  writeStored(next);
  return next;
}

export const useActionShortcutsStore = create<ActionShortcutsStore>((set) => ({
  ...readStored(),
  setActionKeys: (id, keys) => set((state) => persist({
    overrides: keys === appActionDefinition(id).defaultKeys
      ? Object.fromEntries(Object.entries(state.overrides).filter(([key]) => key !== id))
      : { ...state.overrides, [id]: keys },
    skills: state.skills,
  })),
  resetAction: (id) => set((state) => persist({
    overrides: Object.fromEntries(Object.entries(state.overrides).filter(([key]) => key !== id)),
    skills: state.skills,
  })),
  saveSkill: (skill) => set((state) => {
    const others = state.skills.filter((entry) => entry.id !== skill.id && entry.keys !== skill.keys);
    const index = state.skills.findIndex((entry) => entry.id === skill.id);
    const skills = index === -1 ? [...others, skill] : state.skills.map((entry) => (entry.id === skill.id ? skill : entry)).filter((entry) => entry.id === skill.id || entry.keys !== skill.keys);
    return persist({ overrides: state.overrides, skills });
  }),
  removeSkill: (id) => set((state) => persist({ overrides: state.overrides, skills: state.skills.filter((entry) => entry.id !== id) })),
}));

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== ACTION_SHORTCUTS_STORAGE_KEY) return;
    useActionShortcutsStore.setState(readStored());
  });
}

export function dispatchAppAction(target: ShortcutTarget) {
  window.dispatchEvent(new CustomEvent<ShortcutTarget>(APP_ACTION_EVENT, { detail: target }));
}

export function appActionFromEvent(event: Event): ShortcutTarget | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object" || !("type" in detail)) return null;
  if (detail.type === "skill" && "name" in detail && typeof detail.name === "string" && detail.name) return { type: "skill", name: detail.name };
  if (detail.type === "app" && "actionId" in detail) {
    const id = appActionId.safeParse(detail.actionId);
    if (id.success) return { type: "app", actionId: id.data };
  }
  return null;
}
