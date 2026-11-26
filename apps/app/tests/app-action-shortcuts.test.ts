import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const {
  ACTION_SHORTCUTS_STORAGE_KEY,
  actionChordProblem,
  actionKeys,
  appActionFromEvent,
  APP_ACTION_EVENT,
  parseActionShortcuts,
  resolveActionBindings,
  useActionShortcutsStore,
} = await import("../src/react-app/kernel/app-actions");
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const empty = { overrides: {}, skills: [] };

test("saved shortcuts drop unknown actions, malformed data and duplicate skill keys", () => {
  expect(parseActionShortcuts("nope")).toEqual(empty);
  const parsed = parseActionShortcuts({
    overrides: { "panel.toggle": "Mod+Alt+P", "made.up": "Mod+Alt+Q", "session.new": null },
    skills: [
      { id: "a", name: "review", keys: "Mod+Alt+R" },
      { id: "b", name: "deploy", keys: "Mod+Alt+R" },
      { id: "c", name: "triage", keys: "Mod+Alt+T" },
    ],
  });
  expect(parsed.overrides).toEqual({ "panel.toggle": "Mod+Alt+P", "session.new": null });
  expect(parsed.skills.map((skill) => skill.name)).toEqual(["review", "triage"]);
  expect(actionKeys(parsed, "session.new")).toBeNull();
  expect(actionKeys(parsed, "terminal.toggle")).toBe("Mod+J");
});

test("default keys run built-in handlers until they are changed", () => {
  expect(resolveActionBindings(empty)).toEqual({ byChord: new Map(), silenced: new Set() });

  const moved = resolveActionBindings({ overrides: { "terminal.toggle": "Mod+Alt+J" }, skills: [] });
  expect(moved.byChord.get("Mod+Alt+J")).toEqual({ type: "app", actionId: "terminal.toggle" });
  expect([...moved.silenced]).toEqual(["Mod+J"]);

  const cleared = resolveActionBindings({ overrides: { "session.new": null }, skills: [] });
  expect(cleared.byChord.size).toBe(0);
  expect([...cleared.silenced]).toEqual(["Mod+N"]);
});

test("a freed default key can be given to another action or a skill", () => {
  const bindings = resolveActionBindings({
    overrides: { "terminal.toggle": null, "panel.toggle": "Mod+J" },
    skills: [{ id: "s", name: "review", keys: "Mod+Alt+R" }],
  });
  expect(bindings.byChord.get("Mod+J")).toEqual({ type: "app", actionId: "panel.toggle" });
  expect(bindings.byChord.get("Mod+Alt+R")).toEqual({ type: "skill", name: "review" });
  expect(bindings.silenced.has("Mod+J")).toBe(false);
});

test("recorded keys need a modifier, avoid editing keys and are not used twice", () => {
  const state = { overrides: {}, skills: [{ id: "s", name: "review", keys: "Mod+Alt+R" }] };
  const check = (chord: string, ignore = {}) => actionChordProblem({ chord, state, takenElsewhere: [{ chord: "Mod+Alt+1", label: "GPT" }], ignore });
  expect(check("Alt+P")).toEqual({ kind: "needs_modifier" });
  expect(check("Mod+C")).toEqual({ kind: "reserved" });
  expect(check("Mod+K")).toEqual({ kind: "taken", label: "Command palette" });
  expect(check("Mod+K", { actionId: "command-palette.toggle" })).toBeNull();
  expect(check("Mod+B")).toEqual({ kind: "taken", label: "Show or hide left sidebar" });
  expect(check("Mod+Alt+R")).toEqual({ kind: "taken", label: "/review" });
  expect(check("Mod+Alt+R", { skillId: "s" })).toBeNull();
  expect(check("Mod+Alt+1")).toEqual({ kind: "taken", label: "GPT" });
  expect(check("Mod+Shift+P")).toBeNull();
});

test("the store saves overrides on this computer and resetting forgets them", () => {
  const store = useActionShortcutsStore.getState();
  store.setActionKeys("browser.open", "Mod+Shift+B");
  expect(JSON.parse(localStorage.getItem(ACTION_SHORTCUTS_STORAGE_KEY) ?? "{}").overrides).toEqual({ "browser.open": "Mod+Shift+B" });
  store.setActionKeys("session.new", "Mod+N");
  expect("session.new" in useActionShortcutsStore.getState().overrides).toBe(false);
  store.resetAction("browser.open");
  expect(useActionShortcutsStore.getState().overrides).toEqual({});
  store.saveSkill({ id: "x", name: "review", keys: "Mod+Alt+R" });
  store.saveSkill({ id: "y", name: "deploy", keys: "Mod+Alt+R" });
  expect(useActionShortcutsStore.getState().skills.map((skill) => skill.name)).toEqual(["deploy"]);
  store.removeSkill("y");
  expect(useActionShortcutsStore.getState().skills).toEqual([]);
});

test("only well-formed action events are accepted", () => {
  expect(appActionFromEvent(new Event(APP_ACTION_EVENT))).toBeNull();
  expect(appActionFromEvent(new CustomEvent(APP_ACTION_EVENT, { detail: { type: "app", actionId: "nope" } }))).toBeNull();
  expect(appActionFromEvent(new CustomEvent(APP_ACTION_EVENT, { detail: { type: "app", actionId: "dictation.toggle" } }))).toEqual({ type: "app", actionId: "dictation.toggle" });
  expect(appActionFromEvent(new CustomEvent(APP_ACTION_EVENT, { detail: { type: "skill", name: "review" } }))).toEqual({ type: "skill", name: "review" });
});
