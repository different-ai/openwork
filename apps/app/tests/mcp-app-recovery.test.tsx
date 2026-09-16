/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { OpenworkServerError } from "../src/app/lib/openwork-server";
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution";
import type { McpAppDiagnosticStage } from "../src/components/chat/mcp-app-diagnostics";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  GlobalRegistrator.unregister();
});
const { McpAppDiagnosticNotice, isActionableMcpAppResolutionError } = await import("../src/components/chat/mcp-app-frame");

test.each(["mcp_auth_required", "mcp_permission_denied", "mcp_initialization_failed", "mcp_resource_unavailable", "tool_denied"])("%s is actionable without automatic retries", (code) => {
  const error = new OpenworkServerError(422, code, "fixture");
  expect(isActionableMcpAppResolutionError(error)).toBe(true);
  expect(mcpAppResolutionRetryDelayMs(error, 0)).toBeNull();
});

test("transport retries have a finite discovery-only budget", () => {
  const error = new OpenworkServerError(502, "mcp_unreachable", "timeout");
  expect([0, 1, 2, 3].map(attempt => mcpAppResolutionRetryDelayMs(error, attempt))).toEqual([1000, 3000, null, null]);
});

test.each(["mcp_auth_required", "mcp_permission_denied", "mcp_unreachable"])("%s keeps diagnostics collapsed and does not invent identifiers", async (causeCode) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<McpAppDiagnosticNotice notice="Interactive view unavailable." error={{ code: "MCP_APP_RESOLVE_FAILED", causeCode, stage: "resource-resolution", message: "diagnostic-only-message", toolName: "fixture_render", elapsedMs: 10, checkpoints: [] }} />));
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Interactive view unavailable");
    expect(details?.textContent).toContain("diagnostic-only-message");
    expect(container.querySelector("p")?.textContent).not.toContain("diagnostic-only-message");
    expect(container.textContent).not.toContain("Copy diagnostic identifier");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("Interactive view unavailable");
    expect(status?.classList.contains("sr-only")).toBe(true);
    expect(container.querySelectorAll("summary")).toHaveLength(1);
    expect(container.textContent).not.toContain("Technical details");
    expect(Array.from(container.firstElementChild?.children ?? []).filter(child => !child.classList.contains("sr-only"))).toEqual([details]);
    expect(container.textContent).not.toContain("Settings");
    expect(container.textContent).not.toContain("Retry");
    expect([...container.querySelectorAll("button")].every(button => button.closest("details") === details)).toBe(true);
    if (causeCode === "mcp_unreachable") {
      expect(container.textContent).not.toContain("sign-in");
      expect(container.textContent).not.toContain("Reconnect");
    }
  } finally {
    await act(async () => root.unmount());
  }
});

const reloadCases: Array<{ code: string; stage: McpAppDiagnosticStage; allowed: boolean }> = [
  { code: "mcp_unreachable", stage: "resource-resolution", allowed: true },
  { code: "server_unavailable", stage: "resource-resolution", allowed: true },
  { code: "connect_catalog_discovery_unavailable", stage: "resource-resolution", allowed: true },
  { code: "mcp_auth_required", stage: "resource-resolution", allowed: false },
  { code: "mcp_permission_denied", stage: "resource-resolution", allowed: false },
  { code: "tool_denied", stage: "resource-resolution", allowed: false },
  { code: "mcp_resource_unavailable", stage: "resource-resolution", allowed: false },
  { code: "mcp_initialization_failed", stage: "resource-resolution", allowed: false },
  { code: "mcp_unreachable", stage: "app-initialization", allowed: false },
  { code: "mcp_unreachable", stage: "tool-result-delivery", allowed: false },
];

test.each(reloadCases)("reload gating: $code at $stage", async ({ code, stage, allowed }) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let reloads = 0;
  try {
    await act(async () => root.render(<McpAppDiagnosticNotice notice="The normal tool result is still available."
      onReloadView={() => { reloads++; }} error={{ code: "MCP_APP_RESOURCE_RESOLUTION_FAILED", causeCode: code,
        stage, message: "provider diagnostic", toolName: "fixture_render", elapsedMs: 10, checkpoints: [] }} />));
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    const reload = [...container.querySelectorAll("button")].find(button => button.textContent === "Reload view");
    expect(Boolean(reload)).toBe(allowed);
    if (reload) {
      expect(reload.closest("details")).toBe(details);
      if (details) details.open = true;
      await act(async () => reload.click());
      expect(reloads).toBe(1);
    }
    expect(details?.textContent).toContain("provider diagnostic");
    expect(details?.textContent).toContain("Copy details");
  } finally {
    await act(async () => root.unmount());
  }
});
