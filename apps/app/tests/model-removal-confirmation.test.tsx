/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, jest, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ModelRef } from "../src/app/types";
import type { RemovalInventory } from "../src/react-app/domains/session/surface/model-removal";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const den = await import("../src/app/lib/den");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const { useModelRemovalConfirmation } = await import("../src/react-app/domains/session/surface/use-model-removal-confirmation");
const { useModelRecoveryStore } = await import("../src/react-app/domains/session/surface/model-recovery-store");
const { MODEL_UNAVAILABLE_CONFIRMATION_MS: grace } = await import("../src/react-app/domains/session/surface/model-availability");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const selected: ModelRef = { providerID: "ipr_assigned", modelID: "gwm_selected" };
const replacement: ModelRef = { providerID: "ipr_assigned", modelID: "gwm_replacement" };
const absent: RemovalInventory = { models: [], lockedModels: [] };
const assigned: RemovalInventory = { models: [selected], lockedModels: [] };
type Input = Parameters<typeof useModelRemovalConfirmation>[0];
let root: Root | null = null;
let host: HTMLDivElement;
let input: Input;
let settings: ReturnType<typeof den.readDenSettings>;
let inventory = mock(async (_organizationId: string): Promise<RemovalInventory> => absent);
let refresh = mock(async () => true);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
function Probe() {
  const result = useModelRemovalConfirmation(input);
  return <output data-assigned-models={result.assignedModels.map((model) => model.modelID).join(",")}>{String(result.confirmed)}</output>;
}
async function render(patch: Partial<Input> = {}) {
  input = { ...input, ...patch };
  await act(async () => { root?.render(<Probe />); });
}
async function advance(ms: number) {
  await act(async () => { jest.advanceTimersByTime(ms); });
}
function expectPending() { expect(host.textContent).toBe("false"); }

beforeEach(() => {
  jest.useFakeTimers();
  useModelRecoveryStore.setState({ byChat: {} });
  settings = { ...den.readDenSettings(), baseUrl: "https://den.example.test", authToken: "member-token", activeOrgId: "org-a" };
  spyOn(den, "readDenSettings").mockImplementation(() => settings);
  spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_in", user: null, verifiedIdentity: null, error: null, isSignedIn: true, refresh: async () => {} });
  inventory = mock(async (_organizationId: string): Promise<RemovalInventory> => absent);
  refresh = mock(async () => true);
  const client = den.createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken ?? "" });
  spyOn(client, "getModelRemovalInventory").mockImplementation(inventory);
  spyOn(den, "createDenClient").mockReturnValue(client);
  input = { model: selected, missing: true, ready: true, scope: "account/workspace", chatKey: "chat-a", refreshEngine: refresh };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  host.remove();
  useModelRecoveryStore.setState({ byChat: {} });
  mock.restore();
  jest.useRealTimers();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

for (const [label, before, after] of [
  ["both reads", assigned, assigned], ["first read", assigned, absent], ["second read", absent, assigned],
  ["member authorization", { models: [], lockedModels: [selected] }, absent],
] satisfies Array<[string, RemovalInventory, RemovalInventory]>) {
  test(`does not confirm removal while Den retains the assignment in ${label}`, async () => {
    inventory.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await render();
    expectPending();
    await advance(grace);
    expect(inventory).toHaveBeenCalledTimes(2);
    expectPending();
  });
}

test("requires two absent reads and waits for the settled engine refetch", async () => {
  const engine = deferred<boolean>();
  const secondRead = deferred<RemovalInventory>();
  refresh.mockImplementation(() => engine.promise);
  inventory.mockResolvedValueOnce(absent).mockImplementationOnce(() => secondRead.promise);
  await render();
  expect(inventory).toHaveBeenCalledTimes(1);
  expectPending();
  await advance(grace - 1);
  expect(refresh).not.toHaveBeenCalled();
  await advance(1);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(inventory).toHaveBeenCalledTimes(1);
  expectPending();
  await act(async () => engine.resolve(true));
  expect(inventory).toHaveBeenCalledTimes(2);
  expectPending();
  await act(async () => secondRead.resolve(absent));
  expect(host.textContent).toBe("true");
  expect(inventory.mock.calls).toEqual([["org-a"], ["org-a"]]);
  expect(den.createDenClient).toHaveBeenCalledWith({ baseUrl: settings.baseUrl, token: "member-token", requireCompleteInventory: true });
});

test("replacement eligibility comes from the second authoritative read, never stale engine identities", async () => {
  const locked = { providerID: "ipr_assigned", modelID: "gwm_locked" };
  const noLongerAssigned = { providerID: "ipr_assigned", modelID: "gwm_stale_engine" };
  inventory.mockResolvedValueOnce({ models: [replacement, noLongerAssigned], lockedModels: [] });
  inventory.mockResolvedValueOnce({ models: [replacement, locked], lockedModels: [locked] });
  await render();
  await advance(grace);
  expect(host.textContent).toBe("true");
  expect(host.querySelector("output")?.getAttribute("data-assigned-models")).toBe(replacement.modelID);
});

test("an engine refetch that finds the model prevents removal", async () => {
  refresh.mockResolvedValue(false);
  await render();
  await advance(grace);
  expect(inventory).toHaveBeenCalledTimes(2);
  expectPending();
});

for (const phase of ["first", "second", "engine"]) {
  for (const failure of ["offline", "unsupported endpoint"]) {
    test(`${failure} during ${phase} read remains pending and retries`, async () => {
      const error = new Error(failure);
      if (phase === "first") inventory.mockRejectedValueOnce(error);
      if (phase === "second") inventory.mockResolvedValueOnce(absent).mockRejectedValueOnce(error);
      if (phase === "engine") refresh.mockRejectedValueOnce(error);
      await render();
      if (phase !== "first") await advance(grace);
      expectPending();
      const calls = inventory.mock.calls.length;
      await advance(30_000);
      expect(inventory.mock.calls.length).toBe(calls + 1);
      expectPending();
      await advance(grace);
      expect(host.textContent).toBe("true");
    });
  }
}

for (const change of ["organization", "token", "scope", "chat", "model", "not-ready"]) {
  test(`${change} change cancels a stale in-flight confirmation`, async () => {
    const stale = deferred<RemovalInventory>();
    const fresh = deferred<RemovalInventory>();
    inventory.mockResolvedValueOnce(absent).mockImplementationOnce(() => stale.promise).mockImplementation(() => fresh.promise);
    await render();
    await advance(grace);
    expect(inventory).toHaveBeenCalledTimes(2);
    if (change === "organization") settings = { ...settings, activeOrgId: "org-b" };
    if (change === "token") settings = { ...settings, authToken: "new-member-token" };
    await render(change === "scope" ? { scope: "other-workspace" }
      : change === "chat" ? { chatKey: "chat-b" }
      : change === "model" ? { model: replacement }
      : change === "not-ready" ? { ready: false } : {});
    await act(async () => stale.resolve(absent));
    expectPending();
    const calls = inventory.mock.calls.length;
    await advance(30_000);
    expect(inventory).toHaveBeenCalledTimes(calls);
  });
}

for (const phase of ["first inventory", "engine refresh"]) {
  test(`model change cancels a stale ${phase} before the next read`, async () => {
    const staleInventory = deferred<RemovalInventory>();
    const staleEngine = deferred<boolean>();
    const fresh = deferred<RemovalInventory>();
    inventory.mockImplementationOnce(() => phase === "first inventory" ? staleInventory.promise : Promise.resolve(absent))
      .mockImplementation(() => fresh.promise);
    refresh.mockImplementation(() => staleEngine.promise);
    await render();
    if (phase === "engine refresh") await advance(grace);
    await render({ model: replacement });
    expect(inventory).toHaveBeenCalledTimes(2);
    await act(async () => { staleInventory.resolve(absent); staleEngine.resolve(true); });
    await advance(grace + 30_000);
    expect(inventory).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(phase === "engine refresh" ? 1 : 0);
    expectPending();
  });
}

for (const guard of ["signed-out", "missing-token", "missing-organization", "local-model", "not-ready"]) {
  test(`${guard} cannot start removal confirmation`, async () => {
    if (guard === "signed-out") spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, error: null, isSignedIn: false, refresh: async () => {} });
    if (guard === "missing-token") settings = { ...settings, authToken: "  " };
    if (guard === "missing-organization") settings = { ...settings, activeOrgId: "  " };
    await render(guard === "local-model" ? { model: { providerID: "local", modelID: "local-model" } }
      : guard === "not-ready" ? { ready: false } : {});
    await advance(grace + 30_000);
    expect(inventory).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expectPending();
  });
}

test("unmount cancels the grace timer before engine refresh", async () => {
  await render();
  await act(async () => root?.unmount());
  root = null;
  await advance(grace + 30_000);
  expect(refresh).not.toHaveBeenCalled();
  expect(inventory).toHaveBeenCalledTimes(1);
});

test("polls recovery even when the replacement is available and records return and loss", async () => {
  useModelRecoveryStore.getState().record("chat-a", { previous: selected, replacement });
  inventory.mockResolvedValueOnce(absent).mockResolvedValueOnce(assigned).mockResolvedValueOnce(absent);
  await render({ model: replacement, missing: false });
  expect(useModelRecoveryStore.getState().byChat["chat-a"]?.returned).toBe(false);
  await advance(29_999);
  expect(inventory).toHaveBeenCalledTimes(1);
  await advance(1);
  expect(useModelRecoveryStore.getState().byChat["chat-a"]?.returned).toBe(true);
  await act(async () => useModelRecoveryStore.getState().dismiss("chat-a"));
  await advance(30_000);
  expect(useModelRecoveryStore.getState().byChat["chat-a"]?.returned).toBe(false);
  await advance(30_000);
  inventory.mockResolvedValue(assigned);
  await advance(30_000);
  expect(useModelRecoveryStore.getState().byChat["chat-a"]).toMatchObject({ returned: true, dismissed: false });
  expect(refresh).not.toHaveBeenCalled();
  expectPending();
});
