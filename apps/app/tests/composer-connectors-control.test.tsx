import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComposerConnectorsControl } = await import("../src/react-app/domains/session/surface/composer/composer-connectors-control");
type Entry = import("../src/react-app/domains/session/surface/composer/composer-connections").ComposerConnectorEntry;
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

const entry = (key: string, extra: Partial<Entry> = {}): Entry => ({
  key,
  name: key,
  signIn: null,
  connecting: false,
  note: null,
  connected: false,
  ...extra,
});

async function render(connectors: Entry[], handlers: { onConnect?: (entry: Entry) => void; onManage?: () => void; onOpenChange?: (open: boolean) => void } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ComposerConnectorsControl, {
      connectors,
      onConnect: handlers.onConnect ?? (() => {}),
      onManage: handlers.onManage ?? (() => {}),
      onOpenChange: handlers.onOpenChange,
    }));
  });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

test("shows nothing when there is no connector to inspect", async () => {
  const view = await render([]);
  expect(view.host.querySelector("[data-testid=composer-connectors-trigger]")).toBeNull();
  await view.unmount();
});

test("counts the connected connectors on the trigger", async () => {
  const view = await render([entry("notes", { connected: true }), entry("linear", { connected: true }), entry("slack")]);
  const trigger = view.host.querySelector("[data-testid=composer-connectors-trigger]");
  expect(trigger?.textContent).toContain("2 connected");
  expect(trigger?.getAttribute("aria-label")).toBe("Connectors: 2 connected");
  await view.unmount();
});

test("says so when connectors exist but none is connected", async () => {
  const view = await render([entry("slack"), entry("jira")]);
  expect(view.host.querySelector("[data-testid=composer-connectors-trigger]")?.textContent).toContain("None connected");
  await view.unmount();
});

test("lists connected connectors first and offers sign-in for the others", async () => {
  const seen: string[] = [];
  const opened: boolean[] = [];
  const view = await render(
    [
      entry("slack", { signIn: { connectionId: "c1", reconnect: false } }),
      entry("notes", { connected: true }),
      entry("broken", { note: "Issue" }),
    ],
    { onConnect: (connector) => seen.push(connector.key), onOpenChange: (open) => opened.push(open) },
  );
  const trigger = view.host.querySelector<HTMLElement>("[data-testid=composer-connectors-trigger]");
  await act(async () => { trigger?.click(); });
  const list = document.querySelector("[data-testid=composer-connectors-list]");
  expect(list).not.toBeNull();
  const rows = [...(list?.querySelectorAll("li") ?? [])];
  expect(rows.map((row) => row.querySelector(".truncate")?.textContent)).toEqual(["notes", "slack", "broken"]);
  expect(rows.map((row) => row.querySelector("button")?.textContent ?? row.querySelector(".text-xs")?.textContent ?? null)).toEqual([null, "Connect", "Issue"]);
  expect(rows.map((row) => row.getAttribute("data-connected"))).toEqual(["true", "false", "false"]);
  expect(opened).toEqual([true]);
  const connect = [...(list?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.trim() === "Connect");
  await act(async () => { (connect as HTMLElement | undefined)?.click(); });
  expect(seen).toEqual(["slack"]);
  await view.unmount();
});
