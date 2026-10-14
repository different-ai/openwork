import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserEvaluation, Surface } from "@openwork/cdp";
import { readDocumentState, readWorkspaceReadiness } from "./readiness.ts";

const transport = vi.hoisted(() => ({ evalIn: vi.fn() }));
vi.mock("./desktop.ts", () => transport);

const surface: Surface = {
  handle: { name: "readiness", kind: "chrome", hostKind: "local", cdpUrl: "http://127.0.0.1:1" },
  client: {
    close() {},
    async send() { throw new Error("Readiness tests must use the mocked evaluation transport."); },
  },
};

beforeEach(() => {
  transport.evalIn.mockReset();
  // Exercise the owned callback against fixed browser facts, not a copied projection.
  transport.evalIn.mockImplementation(async (_surface: Surface, script: BrowserEvaluation<unknown>) => (
    typeof script === "function" ? script() : Reflect.apply(script.callback, undefined, [...script.args])
  ));
  vi.stubGlobal("document", Object.freeze({ readyState: "complete" }));
  vi.stubGlobal("performance", Object.freeze({ timeOrigin: 123 }));
});
afterEach(() => vi.unstubAllGlobals());

describe("document readiness facts", () => {
  it.each([
    { current: "https://app.test/admin", target: "https://app.test/admin", sameOrigin: true, sameUrl: true, sameDocumentFragment: false },
    { current: "https://app.test/#/session/one", target: "https://app.test/#/session", sameOrigin: true, sameUrl: false, sameDocumentFragment: true },
    { current: "https://app.test/#/session", target: "https://app.test/#/session", sameOrigin: true, sameUrl: true, sameDocumentFragment: true },
    { current: "https://app.test/#/session", target: "https://app.test/#", sameOrigin: true, sameUrl: false, sameDocumentFragment: true },
    { current: "https://app.test/admin", target: "https://app.test/admin/features", sameOrigin: true, sameUrl: false, sameDocumentFragment: false },
    { current: "https://app.test/?page=one#/session", target: "https://app.test/?page=two#/session", sameOrigin: true, sameUrl: false, sameDocumentFragment: false },
    { current: "https://den.test/callback", target: "https://app.test/#/session", sameOrigin: false, sameUrl: false, sameDocumentFragment: false },
  ])("compares $current with $target without returning either URL", async ({ current, target, ...comparison }) => {
    vi.stubGlobal("location", new URL(current));
    expect(await readDocumentState(surface, target)).toEqual({ timeOrigin: 123, readyState: "complete", complete: true, ...comparison });
    expect(transport.evalIn).toHaveBeenCalledTimes(1);
  });

  it("does not expose current credentials, OAuth query parameters, or fragments", async () => {
    vi.stubGlobal("location", new URL("https://member:private-password@app.test/callback?code=private-code&state=private-state#private-fragment"));
    const state = await readDocumentState(surface, "https://app.test/admin");
    expect(state).toEqual({ timeOrigin: 123, readyState: "complete", complete: true, sameOrigin: true, sameUrl: false, sameDocumentFragment: false });
    expect(JSON.stringify(state)).not.toMatch(/private-|callback|member/);
  });

  it("reports loading and a changed document epoch independently", async () => {
    vi.stubGlobal("location", new URL("https://app.test/admin"));
    const before = await readDocumentState(surface, "https://app.test/admin");
    vi.stubGlobal("performance", Object.freeze({ timeOrigin: 456 }));
    vi.stubGlobal("document", Object.freeze({ readyState: "loading" }));
    const after = await readDocumentState(surface, "https://app.test/admin");
    expect(after.timeOrigin).not.toBe(before.timeOrigin);
    expect(after).toMatchObject({ sameUrl: true, readyState: "loading", complete: false });
  });

  it("rejects credential-bearing and invalid targets without echoing them", async () => {
    await expect(readDocumentState(surface, "https://member:private-password@app.test/admin"))
      .rejects.toThrow("Document state requires an absolute HTTP(S) target URL without credentials.");
    await expect(readDocumentState(surface, "private-invalid-target"))
      .rejects.toThrow("Document state requires an absolute HTTP(S) target URL.");
    expect(transport.evalIn).not.toHaveBeenCalled();
  });

  it("rejects malformed transport facts", async () => {
    transport.evalIn.mockResolvedValueOnce({ timeOrigin: 0 });
    await expect(readDocumentState(surface, "https://app.test/admin"))
      .rejects.toThrow("invalid document readiness facts");
  });
});

const readyRoute = {
  connected: true,
  loading: false,
  connectionPending: false,
  routeError: null,
  selectedWorkspaceId: "expected-workspace",
  workspaces: [{ id: "expected-workspace", loading: false, error: null }],
};

describe("workspace readiness facts", () => {
  it("requires the expected selected workspace and reads only the public route slice", async () => {
    const slice = vi.fn(() => readyRoute);
    vi.stubGlobal("window", { __openwork: { slice } });
    expect(await readWorkspaceReadiness(surface, "expected-workspace")).toEqual({
      connected: true, notLoading: true, connectionReady: true, noRouteError: true,
      expectedWorkspaceSelected: true, workspaceLoaded: true, noWorkspaceError: true,
    });
    expect(slice).toHaveBeenCalledExactlyOnceWith("route");
  });

  it.each([
    { name: "disconnected route", state: { ...readyRoute, connected: false }, flag: "connected" },
    { name: "loading route", state: { ...readyRoute, loading: true }, flag: "notLoading" },
    { name: "pending connection", state: { ...readyRoute, connectionPending: true }, flag: "connectionReady" },
    { name: "route error", state: { ...readyRoute, routeError: "private-diagnostic" }, flag: "noRouteError" },
    { name: "different workspace", state: { ...readyRoute, selectedWorkspaceId: "other-workspace" }, flag: "expectedWorkspaceSelected" },
    { name: "missing workspace", state: { ...readyRoute, workspaces: [] }, flag: "workspaceLoaded" },
    { name: "loading workspace", state: { ...readyRoute, workspaces: [{ id: "expected-workspace", loading: true, error: null }] }, flag: "workspaceLoaded" },
    { name: "workspace error", state: { ...readyRoute, workspaces: [{ id: "expected-workspace", loading: false, error: "private-diagnostic" }] }, flag: "noWorkspaceError" },
  ])("does not report readiness for $name", async ({ state, flag }) => {
    vi.stubGlobal("window", { __openwork: { slice: () => state } });
    const facts = await readWorkspaceReadiness(surface, "expected-workspace");
    expect(facts).toMatchObject({ [flag]: false });
    expect(Object.values(facts).every(value => value === true)).toBe(false);
    expect(JSON.stringify(facts)).not.toContain("private-diagnostic");
  });

  it("reports not ready when the public inspector is not registered", async () => {
    vi.stubGlobal("window", {});
    expect(Object.values(await readWorkspaceReadiness(surface, "expected-workspace"))).toEqual(Array(7).fill(false));
  });

  it("rejects malformed transport facts", async () => {
    transport.evalIn.mockResolvedValueOnce({ connected: true });
    await expect(readWorkspaceReadiness(surface, "expected-workspace"))
      .rejects.toThrow("invalid workspace readiness facts");
  });
});
