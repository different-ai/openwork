/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { EngineActivity, EngineV2MigrationStatus, EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const runtime = await import("../src/app/lib/runtime-env");
const { OpenworkServerError } = await import("../src/app/lib/openwork-server");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
const { EngineMigrationOverlay, observeEngineMigration, resetEngineMigrationForTest } = await import("../src/react-app/shell/engine-migration");
const { toast } = await import("../src/components/ui/sonner");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let desktop: ReturnType<typeof spyOn>;
let state: EngineV2PreviewStatus;
let activity: EngineActivity;
let switches: string[];
let migrations: Array<{ allowActiveSessions?: boolean }>;
let refuseMigration: number;
const idle = { verdict: "idle" as const, busySessions: 0, waitingRequests: 0 };
const client = {
  getEngineV2PreviewStatus: async () => state,
  getEngineActivity: async () => activity,
  switchOpencodeEngine: async (engine: "v1" | "v2") => {
    switches.push(engine);
    state = { ...state, enabled: engine === "v2", chatRouting: engine === "v2", running: engine === "v2" };
    return state;
  },
  migrateOpencodeHistory: async (options: { allowActiveSessions?: boolean } = {}) => {
    if (refuseMigration > 0 && !options.allowActiveSessions) {
      throw new OpenworkServerError(409, "engine_migration_active_sessions", "Wait for running tasks to finish before migrating chats.",
        { busySessions: refuseMigration, waitingRequests: 0 });
    }
    migrations.push(options);
    state = { ...state, migration: { state: "completed", imported: 2, skipped: 1, total: 3 } };
    return state;
  },
};
function Harness() {
  const engine = useOpencodeEngineControls(client);
  return <>
    {engine.items.map((item) => <button key={item.id} disabled={item.disabled} onClick={item.action}>{item.title}</button>)}
    <span>{engine.message}</span><span>{engine.blockedReason}</span>
    <EngineMigrationOverlay discoverRunningMigration={false} />
  </>;
}
beforeEach(() => {
  state = { enabled: false, running: false, chatRouting: false, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [], migration: { state: "idle", imported: 0, skipped: 0, total: 0 } };
  activity = { v1: idle, v2: null };
  switches = []; migrations = []; refuseMigration = 0;
  resetEngineMigrationForTest();
  desktop = spyOn(runtime, "isDesktopRuntime").mockReturnValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); desktop.mockRestore(); resetEngineMigrationForTest(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });
async function settle() {
  await act(async () => { for (let index = 0; index < 20; index += 1) await Promise.resolve(); });
}
async function click(title: string) {
  await act(async () => button(title).click());
  await settle();
}
function button(title: string) {
  const value = [...document.querySelectorAll("button")].find((button) => button.textContent === title);
  if (!value) throw new Error(`Missing button ${title}`);
  return value;
}
const dialogText = (role = "alertdialog") => document.querySelector(`[role="${role}"]`)?.textContent ?? "";
async function render() {
  await act(async () => root.render(<Harness />));
  await settle();
}
async function showMigration(migration: EngineV2MigrationStatus) {
  state = { ...state, migration };
  await act(async () => observeEngineMigration(client, state));
  await settle();
}

test("switch commands select both engines without starting migration", async () => {
  await render();
  expect(button("Switch to OpenCode v1").disabled).toBe(true);
  await click("Switch to OpenCode v2");
  expect(switches).toEqual(["v2"]);
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  await click("Switch to OpenCode v1");
  expect(switches).toEqual(["v2", "v1"]);
  expect(migrations).toHaveLength(0);
});

test("migration requires explicit consent, cancel is inert, and migration does not switch engines", async () => {
  await render();
  await click("Migrate chats to OpenCode v2");
  expect(dialogText()).toContain("Your v1 chats stay as they are");
  expect(migrations).toHaveLength(0);
  await click("Cancel");
  expect(migrations).toHaveLength(0);
  await click("Migrate chats to OpenCode v2");
  await click("Migrate chats");
  expect(migrations).toEqual([{ allowActiveSessions: false }]);
  expect(switches).toEqual([]);
  expect(host.textContent).toContain("Migrated 2 chats; 1 already in v2.");
  expect(dialogText("dialog")).toContain("Chats migrated to OpenCode v2");
});

test("running v1 tasks are named before migrating, and continuing is an explicit choice", async () => {
  activity = { v1: { verdict: "busy", busySessions: 2, waitingRequests: 0 }, v2: null };
  await render();
  await click("Migrate chats to OpenCode v2");
  expect(dialogText()).toContain("2 tasks are still running");
  expect(() => button("Migrate chats")).toThrow();
  await click("Migrate anyway");
  expect(migrations).toEqual([{ allowActiveSessions: true }]);
});

test("a migration the server refuses for running tasks shows the same warning instead of an error", async () => {
  refuseMigration = 1;
  activity = { v1: { verdict: "unknown", busySessions: 0, waitingRequests: 0 }, v2: null };
  await render();
  await click("Migrate chats to OpenCode v2");
  await click("Migrate chats");
  expect(migrations).toHaveLength(0);
  expect(dialogText()).toContain("1 task is still running");
  await click("Migrate anyway");
  expect(migrations).toEqual([{ allowActiveSessions: true }]);
});

test("a running migration blocks with progress, can continue in the background, and comes back", async () => {
  await render();
  await showMigration({ state: "running", phase: "copying", imported: 1_180, skipped: 20, total: 2_965, startedAt: new Date().toISOString() });
  expect(dialogText("dialog")).toContain("Migrating chats to OpenCode v2");
  expect(dialogText("dialog")).toContain("1,200 of 2,965 chats copied");
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  expect(button("Migrate chats to OpenCode v2").disabled).toBe(true);
  await click("Continue using OpenWork");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[data-testid="engine-migration-banner"]')?.textContent).toContain("OpenWork may be unstable");
  await click("Show progress");
  expect(dialogText("dialog")).toContain("1,200 of 2,965 chats copied");
  await click("Continue using OpenWork");
  const finished = spyOn(toast, "success");
  try {
    await showMigration({ state: "completed", imported: 2_945, skipped: 20, total: 2_965 });
    // Finishing in the background does not take the screen back: it reports
    // the result and offers the next step.
    expect(document.querySelector('[data-testid="engine-migration-banner"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0]?.[1]).toMatchObject({
      description: "Migrated 2,945 chats; 20 already in v2.",
      action: { label: "Switch to OpenCode v2" },
    });
  } finally {
    finished.mockRestore();
  }
});

test("the copy count waits for conversion instead of showing a stalled 0 of N", async () => {
  await render();
  await showMigration({ state: "running", phase: "converting", imported: 0, skipped: 0, total: 2_965 });
  expect(dialogText("dialog")).toContain("2,965 chats to copy");
  expect(dialogText("dialog")).not.toContain("0 of 2,965");
  expect(host.textContent).toContain("Migrating chats…");
});

test("a failed migration says what is kept and retries in place", async () => {
  await render();
  await showMigration({ state: "running", phase: "copying", imported: 3, skipped: 0, total: 10 });
  await click("Continue using OpenWork");
  // A failure needs a decision, so it brings the dialog back from the background.
  await showMigration({ state: "error", imported: 4, skipped: 0, total: 10, error: "Could not import a chat (500). Retry migration; existing v2 chats will be skipped." });
  expect(dialogText("dialog")).toContain("Migration didn't finish");
  expect(dialogText("dialog")).toContain("Could not import a chat (500)");
  await click("Try again");
  expect(migrations).toEqual([{ allowActiveSessions: false }]);
  expect(dialogText("dialog")).toContain("Chats migrated to OpenCode v2");
  await click("Switch to OpenCode v2");
  expect(switches).toEqual(["v2"]);
});

test("switching away from running v1 tasks asks first and keeping v1 changes nothing", async () => {
  activity = { v1: { verdict: "busy", busySessions: 1, waitingRequests: 0 }, v2: null };
  await render();
  await click("Switch to OpenCode v2");
  expect(dialogText()).toContain("1 task is still running on OpenCode v1");
  await click("Keep OpenCode v1");
  expect(switches).toEqual([]);
  await click("Switch to OpenCode v2");
  await click("Switch anyway");
  expect(switches).toEqual(["v2"]);
});

test("switching back to v1 says it interrupts running v2 tasks", async () => {
  state = { ...state, enabled: true, chatRouting: true, running: true };
  activity = { v1: idle, v2: { verdict: "busy", busySessions: 2, waitingRequests: 0 } };
  await render();
  await click("Switch to OpenCode v1");
  expect(dialogText()).toContain("2 tasks are still running on OpenCode v2");
  expect(dialogText()).toContain("stops OpenCode v2");
  await click("Stop tasks and switch");
  expect(switches).toEqual(["v1"]);
});

test("web controls stay visible with an actionable blocked reason", async () => {
  desktop.mockReturnValue(false);
  await render();
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  expect(button("Migrate chats to OpenCode v2").disabled).toBe(true);
  expect(host.textContent).toContain("Available in the desktop app");
});

test("history migration prevents engine switching and duplicate submits", async () => {
  state.migration = { state: "running", imported: 1, skipped: 0, total: 3 };
  await render();
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  expect(button("Migrate chats to OpenCode v2").disabled).toBe(true);
  expect(host.textContent).toContain("Migrating chats: 1 of 3");
});
