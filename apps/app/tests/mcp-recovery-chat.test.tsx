/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError } from "../src/app/lib/openwork-server";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); GlobalRegistrator.unregister(); });
const { RecoveryChatFixture, recoveryMessages, connectionMessages } = await import("./fixtures/mcp-recovery-chat");

test("a signed-out view does not replace the task answer or invent a reconnect action", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const original = JSON.stringify(recoveryMessages);
  let resolutions = 0;
  let toolCalls = 0;
  const client = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => { resolutions++; throw new OpenworkServerError(401, "mcp_auth_required", "HTTP 401"); },
    callMcpAppTool: async () => { toolCalls++; throw new Error("Must not execute tools"); },
  };
  try {
    await act(async () => root.render(<RecoveryChatFixture client={client} />));
    expect(container.textContent).toContain("Find the release blockers");
    expect(container.textContent).toContain("Both need verification before the release.");
    expect(container.querySelector("summary")?.textContent).toBe("Interactive view unavailable");
    expect(container.textContent).not.toContain("Settings");
    expect(container.textContent).not.toContain("Connection needs sign-in");
    expect([...container.querySelectorAll("button")].some(button => /^(Retry|Reload view|Connect|Reconnect)$/.test(button.textContent ?? ""))).toBe(false);
    const details = container.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("mcp_auth_required");
    expect(details?.textContent).toContain("Copy details");
    expect(JSON.stringify(recoveryMessages)).toBe(original);
    expect(resolutions).toBe(1);
    expect(toolCalls).toBe(0);
  } finally { await act(async () => root.unmount()); }
});

test("an authoritative connection payload gets one existing contextual card, not another view failure", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  let resolutions = 0;
  const client = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => { resolutions++; throw new Error("Connection cards must not resolve an App"); },
  };
  try {
    await act(async () => root.render(<RecoveryChatFixture client={client} messages={connectionMessages} />));
    expect(container.querySelectorAll('[data-testid="desktop-connection-card"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Notes connection"]')).not.toBeNull();
    expect(container.textContent).toContain("Checked Notes connection");
    expect(container.textContent).not.toContain("Used *");
    expect(container.textContent).toContain("The release checklist has not been read yet.");
    expect(container.textContent).not.toContain("Interactive view unavailable");
    expect(container.textContent).not.toContain("Reload view");
    expect(resolutions).toBe(0);
  } finally { await act(async () => root.unmount()); }
});
