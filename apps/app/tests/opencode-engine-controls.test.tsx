/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
const { createRoot } = await import("react-dom/client");
const runtime = await import("../src/app/lib/runtime-env");
const { useOpencodeEngineControls } = await import("../src/react-app/shell/opencode-engine-controls");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let desktop: ReturnType<typeof spyOn>;
let state: EngineV2PreviewStatus;
let switches: string[];
let migrations: number;
const client = {
  getEngineV2PreviewStatus: async () => state,
  switchOpencodeEngine: async (engine: "v1" | "v2") => {
    switches.push(engine);
    state = { ...state, enabled: engine === "v2", chatRouting: engine === "v2", running: engine === "v2" };
    return state;
  },
  migrateOpencodeHistory: async () => { migrations++; state = { ...state, migration: { state: "completed", imported: 2, skipped: 1, total: 3 } }; return state; },
};
function Harness() {
  const engine = useOpencodeEngineControls(client);
  return <>{engine.items.map((item) => <button key={item.id} disabled={item.disabled} onClick={item.action}>{item.title}</button>)}{engine.dialog}<span>{engine.message}</span><span>{engine.blockedReason}</span></>;
}
beforeEach(() => {
  state = { enabled: false, running: false, chatRouting: false, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [], migration: { state: "idle", imported: 0, skipped: 0, total: 0 } };
  switches = []; migrations = 0;
  desktop = spyOn(runtime, "isDesktopRuntime").mockReturnValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); desktop.mockRestore(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });
function button(title: string) {
  const value = [...document.querySelectorAll("button")].find((button) => button.textContent === title);
  if (!value) throw new Error(`Missing button ${title}`);
  return value;
}
test("switch commands select both engines without starting migration", async () => {
  await act(async () => root.render(<Harness />));
  expect(button("Switch to OpenCode v1").disabled).toBe(true);
  await act(async () => button("Switch to OpenCode v2").click());
  expect(switches).toEqual(["v2"]);
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  await act(async () => button("Switch to OpenCode v1").click());
  expect(switches).toEqual(["v2", "v1"]);
  expect(migrations).toBe(0);
});
test("migration requires explicit consent, cancel is inert, and migration does not switch engines", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => button("Migrate chats to OpenCode v2").click());
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Your v1 history stays unchanged");
  expect(migrations).toBe(0);
  await act(async () => button("Cancel").click());
  expect(migrations).toBe(0);
  await act(async () => button("Migrate chats to OpenCode v2").click());
  await act(async () => button("Migrate chats").click());
  expect(migrations).toBe(1);
  expect(switches).toEqual([]);
  expect(host.textContent).toContain("Migrated 2 chats; 1 already in v2.");
});
test("web controls stay visible with an actionable blocked reason", async () => {
  desktop.mockReturnValue(false);
  await act(async () => root.render(<Harness />));
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  expect(button("Migrate chats to OpenCode v2").disabled).toBe(true);
  expect(host.textContent).toContain("Available in the desktop app");
});
test("history migration prevents engine switching and duplicate submits", async () => {
  state.migration = { state: "running", imported: 1, skipped: 0, total: 3 };
  await act(async () => root.render(<Harness />));
  expect(button("Switch to OpenCode v2").disabled).toBe(true);
  expect(button("Migrate chats to OpenCode v2").disabled).toBe(true);
  expect(host.textContent).toContain("Migrating chats: 1 of 3");
});
