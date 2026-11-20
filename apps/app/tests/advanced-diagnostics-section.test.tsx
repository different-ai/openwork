/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { OpenworkCloudMcpHealth } from "../src/app/lib/openwork-server";
import {
  diagnosticsVersionLine,
  summarizeDiagnostics,
} from "../src/react-app/domains/settings/pages/diagnostics-summary";

const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let createRoot: typeof import("react-dom/client")["createRoot"];
let AdvancedDiagnosticsSection: typeof import("../src/react-app/domains/settings/pages/advanced-diagnostics-section")["AdvancedDiagnosticsSection"];
let root: Root | null = null;
let host: HTMLDivElement;
let previousAct: unknown;

function health(overrides: Partial<OpenworkCloudMcpHealth> = {}): OpenworkCloudMcpHealth {
  return {
    schemaVersion: 1,
    phase: "ready",
    usable: true,
    usableByCurrentModel: true,
    connectCatalogEnabled: true,
    workspace: { id: "workspace-1", type: "local", directory: "/tmp/project", path: "/tmp/project" },
    desired: {
      present: true,
      name: "openwork-cloud",
      revision: "revision-1",
      config: { enabled: true },
      token: { present: true, metadata: {} },
    },
    delivery: {
      state: "ready",
      desiredRevision: "revision-1",
      appliedRevision: "revision-1",
      updatedAt: null,
      appliedAt: null,
      lastAttemptAt: null,
    },
    engine: { status: "connected" },
    tools: {
      expected: ["search_capabilities", "execute_capability"],
      present: ["search_capabilities", "execute_capability"],
      missing: [],
      direct: { checked: true, source: "mcp_tools_list", expected: [], present: [], missing: [] },
      providerProjection: { checked: false, present: [], missing: [] },
    },
    pluginCanaries: { expected: [], present: [], missing: [] },
    compatibility: {
      openwork: { serverVersion: "0.18.70", app: { version: "0.18.70" } },
      opencode: { expectedVersion: "2.2.0", actualVersion: "2.2.0", probe: "ok" },
      pluginFileHashes: [],
      supportedFeatures: {
        dynamicMcp: true,
        directoryScoping: true,
        toolIds: true,
        providerToolProjection: true,
        pluginCanaries: true,
      },
      experimentalToolIds: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
      experimentalProviderTools: { checked: false, expected: [], present: [], missing: [], includesMcpTools: null },
    },
    toolDenies: [],
    firstFailure: null,
    checkedAt: "2026-11-13T18:42:00.000Z",
    ...overrides,
  };
}

const expiredSignIn = health({
  usable: false,
  firstFailure: {
    code: "openwork_cloud_token_expired",
    stage: "cloud_auth",
    retryable: true,
    recommendedAction: "Sign in again.",
    message: "The Cloud token expired.",
  },
});

describe("diagnostics summary", () => {
  const signedIn = { checking: false, canCheck: true, signedIn: true, orgSelected: true };

  test("working tools read as one reassuring line", () => {
    expect(summarizeDiagnostics({ ...signedIn, health: health() })).toEqual({
      tone: "ready",
      label: "Working",
      detail: "Your connected tools are ready to use.",
    });
  });

  test("a failure names what went wrong in plain words, not the failure code", () => {
    const summary = summarizeDiagnostics({ ...signedIn, health: expiredSignIn });
    expect(summary).toEqual({
      tone: "error",
      label: "Needs attention",
      detail: "Cloud authentication expired. Copy the report and send it to OpenWork support.",
    });
    expect(summary.detail).not.toContain("openwork_cloud_token_expired");
  });

  test("tools switched off are not reported as a problem", () => {
    const off = health({ usable: false, desired: { ...health().desired, config: { enabled: false } } });
    expect(summarizeDiagnostics({ ...signedIn, health: off }).label).toBe("Turned off");
  });

  test("without a result it says what is missing instead of guessing a status", () => {
    expect(summarizeDiagnostics({ ...signedIn, health: null }).label).toBe("Not checked");
    expect(summarizeDiagnostics({ ...signedIn, signedIn: false, health: null }).label).toBe("Signed out");
    expect(summarizeDiagnostics({ ...signedIn, orgSelected: false, health: null }).label).toBe("No organization");
    expect(summarizeDiagnostics({ ...signedIn, checking: true, health: null }).label).toBe("Checking");
    expect(summarizeDiagnostics({ ...signedIn, canCheck: false, health: null }).detail)
      .toBe("The check runs once this workspace is connected.");
  });

  test("checking again keeps the last result on screen", () => {
    expect(summarizeDiagnostics({ ...signedIn, checking: true, health: expiredSignIn }).label).toBe("Needs attention");
  });

  test("the version line leads with the app version and works before any check", () => {
    expect(diagnosticsVersionLine({ appVersion: "0.18.70", health: null })).toBe("OpenWork v0.18.70");
    expect(diagnosticsVersionLine({ appVersion: null, health: health() })).toBe("OpenWork v0.18.70, OpenCode 2.2.0");
    expect(diagnosticsVersionLine({ appVersion: null, health: null })).toBeNull();
  });
});

describe("Diagnostics section", () => {
  beforeAll(async () => {
    if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
    createRoot = (await import("react-dom/client")).createRoot;
    AdvancedDiagnosticsSection = (await import("../src/react-app/domains/settings/pages/advanced-diagnostics-section")).AdvancedDiagnosticsSection;
  });
  afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
  beforeEach(() => {
    previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  });

  async function render(props: Partial<Parameters<typeof AdvancedDiagnosticsSection>[0]> = {}) {
    const calls = { refresh: 0, copy: 0 };
    await act(async () => root?.render(
      <AdvancedDiagnosticsSection
        appVersion="0.18.70"
        signedIn
        orgSelected
        cloudMcpHealth={health()}
        canCheck
        onRefresh={async () => { calls.refresh += 1; return null; }}
        onCopyReport={async () => { calls.copy += 1; }}
        {...props}
      />,
    ));
    return calls;
  }

  function button(label: string) {
    return [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.trim() === label);
  }

  test("shows the status and app version up front and keeps the technical rows folded away", async () => {
    await render();
    const summary = host.querySelector('[data-testid="diagnostics-summary"]')?.textContent ?? "";
    expect(summary).toContain("Working");
    expect(summary).toContain("OpenWork v0.18.70, OpenCode 2.2.0 — checked ");
    const details = host.querySelector("details");
    expect(details?.querySelector("summary")?.textContent?.trim()).toBe("Technical details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Desired revision");
  });

  test("Copy report hands the whole report to the caller in one click", async () => {
    const calls = await render();
    await act(async () => { button("Copy report")?.click(); });
    expect(calls.copy).toBe(1);
  });

  test("copying still works before anything has been checked", async () => {
    const calls = await render({ cloudMcpHealth: null, signedIn: false });
    expect(host.textContent).toContain("Signed out");
    expect(host.textContent).toContain("OpenWork v0.18.70");
    expect(host.querySelector("details")).toBeNull();
    await act(async () => { button("Copy report")?.click(); });
    expect(calls).toEqual({ refresh: 0, copy: 1 });
  });

  test("opening it signed in with no result runs the check once", async () => {
    const first = await render({ cloudMcpHealth: null });
    expect(first.refresh).toBe(1);
    const rerender = await render({ cloudMcpHealth: null });
    expect(rerender.refresh).toBe(0);
  });

  test("the page can open before the workspace is connected; the check runs when it is", async () => {
    const early = await render({ cloudMcpHealth: null, canCheck: false });
    expect(early.refresh).toBe(0);
    expect(host.textContent).toContain("The check runs once this workspace is connected.");
    expect(button("Check again")?.disabled).toBe(true);
    const connected = await render({ cloudMcpHealth: null, canCheck: true });
    expect(connected.refresh).toBe(1);
  });

  test("a failed check says so instead of leaving a stale status", async () => {
    await render({ cloudMcpHealth: null, onRefresh: async () => { throw new Error("OpenWork server is not running."); } });
    expect(host.textContent).toContain("OpenWork server is not running.");
    expect(host.textContent).toContain("Not checked");
  });
});
