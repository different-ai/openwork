/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RemoteSessionAccessMode } from "@openwork/types/automations";
import type { RemoteSessionAccessState } from "../src/app/lib/desktop";
import { RemoteAccessAskCard, remoteAccessAsk } from "../src/react-app/domains/devices/remote-access-ask";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

/** A computer under the opt-in whose owner has not chosen, in an organization that allows every level. */
const unchosen: RemoteSessionAccessState = { mode: null, ceiling: "all", effective: "off", supported: true, optIn: true, connected: true };

let client: QueryClient;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function renderAsk(state: RemoteSessionAccessState) {
  const written: RemoteSessionAccessMode[] = [];
  const write = async (mode: RemoteSessionAccessMode): Promise<RemoteSessionAccessState> => {
    written.push(mode);
    return { ...state, mode, effective: mode };
  };
  await act(async () => root.render(<QueryClientProvider client={client}><RemoteAccessAskCard read={async () => state} write={write} /></QueryClientProvider>));
  await settle();
  return written;
}

/** The query hands its result to React on a timer, so one turn of the loop lets a read or a save reach the page. */
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function press(label: string) {
  await act(async () => button(label).click());
  await settle();
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(candidate => candidate.textContent === label);
  if (!found) throw new Error(`No "${label}" button in: ${container.textContent}`);
  return found;
}

test("asks only while the opt-in leaves a computer off for want of a choice", () => {
  expect(remoteAccessAsk(undefined)).toBeNull();
  expect(remoteAccessAsk({ ...unchosen, connected: false })).toBeNull();
  expect(remoteAccessAsk({ ...unchosen, optIn: false, effective: "created" })).toBeNull();
  expect(remoteAccessAsk({ ...unchosen, mode: "off" })).toBeNull();
  expect(remoteAccessAsk({ ...unchosen, mode: "created", effective: "created" })).toBeNull();
  // The organization turned tasks from other devices off: the owner could allow nothing.
  expect(remoteAccessAsk({ ...unchosen, ceiling: "off" })).toBeNull();
  expect(remoteAccessAsk(unchosen)?.options.map(option => [option.mode, option.locked])).toEqual([["all", null], ["created", null]]);
});

test("the button starts on every task where that can apply, and on starting tasks where it cannot", () => {
  expect(remoteAccessAsk(unchosen)?.initial.mode).toBe("all");

  const limited = remoteAccessAsk({ ...unchosen, ceiling: "created" });
  expect(limited?.initial.mode).toBe("created");
  expect(limited?.options[0]).toMatchObject({ mode: "all", locked: "Your organization only allows tasks started remotely." });

  const unsupported = remoteAccessAsk({ ...unchosen, supported: false });
  expect(unsupported?.initial.mode).toBe("created");
  expect(unsupported?.options[0]).toMatchObject({ mode: "all", locked: "Sign in again or update OpenWork to use this." });
});

test("allowing saves the level on the button and the ask goes away", async () => {
  const written = await renderAsk(unchosen);
  expect(container.textContent).toContain("Let Workbot and your other devices work on this computer?");
  await press("Allow all tasks");
  expect(written).toEqual(["all"]);
  expect(container.querySelector('[data-testid="remote-access-ask"]')).toBeNull();
});

test("an organization that only allows starting tasks gets that on the button", async () => {
  const written = await renderAsk({ ...unchosen, ceiling: "created" });
  await press("Allow starting tasks");
  expect(written).toEqual(["created"]);
});

test("keeping it off is saved as the owner's choice, so the ask does not come back", async () => {
  const written = await renderAsk(unchosen);
  await press("Keep it off");
  expect(written).toEqual(["off"]);
  expect(container.querySelector('[data-testid="remote-access-ask"]')).toBeNull();
});

test("nothing is shown to an owner who already chose or an organization without the opt-in", async () => {
  await renderAsk({ ...unchosen, mode: "created", effective: "created" });
  expect(container.textContent).toBe("");
});
