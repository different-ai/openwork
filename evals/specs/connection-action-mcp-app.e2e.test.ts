import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connect, debuggerUrlFor, listTargets, type Surface, type CdpClient } from "@openwork/cdp";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionReply, isRecord, records } from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, { timeout: 600_000 });

// Inspect and click the rendered sandbox document, without bypassing its bridge.
async function cardDocument(app: Surface, click?: string): Promise<string> {
  const visit = async (client: CdpClient, node: unknown): Promise<string> => {
    if (!isRecord(node) || !isRecord(node.frame)) return "";
    if (typeof node.frame.id === "string") {
      const world = await client.send("Page.createIsolatedWorld", { frameId: node.frame.id, worldName: "connection-card-proof" }).catch(() => null);
      if (isRecord(world) && typeof world.executionContextId === "number") {
        const inspected = await client.send("Runtime.evaluate", {
          contextId: world.executionContextId, returnByValue: true,
          expression: `(() => {
            const card = document.querySelector('main.card');
            if (!card || !card.textContent.includes('Notes')) return '';
            const label = ${JSON.stringify(click ?? "")};
            if (label) {
              const button = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === label);
              if (!button || button.disabled) return '';
              button.click();
            }
            return card.innerText;
          })()`,
        }).catch(() => null);
        if (isRecord(inspected) && isRecord(inspected.result) && typeof inspected.result.value === "string" && inspected.result.value) return inspected.result.value;
      }
    }
    for (const child of records(node.childFrames)) {
      const text = await visit(client, child);
      if (text) return text;
    }
    return "";
  };
  const inspect = async (client: CdpClient) => {
    const result = await client.send("Page.getFrameTree");
    return visit(client, isRecord(result) ? result.frameTree : null);
  };
  const main = await inspect(app.client);
  if (main) return main;
  // Chromium isolates the App sandbox in a separate renderer process.
  for (const target of await listTargets(app.handle.cdpUrl)) {
    if (target.type !== "iframe" || !target.url.includes("/mcp-apps/sandbox.html")) continue;
    const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
    try {
      const text = await inspect(client);
      if (text) return text;
    } finally {
      client.close();
    }
  }
  return "";
}

test("gateway discovery renders a connection card and checks live authorization in chat", async ({ world, agent, user, probe, evidence }) => {
  expect(connectionActionPrompt).not.toContain(world.connection.id);
  await agent.send(connectionActionPrompt);
  await user.see({ text: connectionActionReply }, { timeoutMs: 120_000 });
  const initial = await probe.eventually(() => cardDocument(world.app), {
    within: 60_000, intervalMs: 1_000, label: "connection card rendered directly from search",
    until: text => text.includes("Check connection") && text.includes("Not connected"),
  });
  expect(initial).toContain("Connect Notes");
  const calls = await world.den.mocks.connector.agentRequests({ promptMarker: connectionActionPrompt });
  expect(calls.filter(call => call.kind === "tool").every(call => call.toolName?.endsWith("search_capabilities"))).toBe(true);
  expect(calls.filter(call => call.kind === "tool")).toHaveLength(1);
  await user.screenshot();
  evidence.recordAssertionEvidence("Search renders an actionable connection card without an execute call", initial, initial.includes("Connect Notes") && initial.includes("Check connection"));

  expect(await cardDocument(world.app, "Check connection")).toBeTruthy();
  const stillDisconnected = await probe.eventually(() => cardDocument(world.app), {
    within: 30_000, intervalMs: 500, label: "checking before OAuth does not claim connected",
    until: text => text.includes("Check connection") && text.includes("Not connected"),
  });
  expect(stillDisconnected).not.toContain("Connection ready");
  evidence.recordAssertionEvidence("Checking before authorization keeps the card disconnected", stillDisconnected, !stillDisconnected.includes("Connection ready"));

  const started = await probe.api(world.den.admin, `/v1/mcp-connections/${world.connection.id}/connect/start`, {
    method: "GET", headers: { "x-openwork-org-id": world.organizationId },
  });
  expect(started.response.ok, started.text).toBe(true);
  const authorizeUrl = isRecord(started.body) ? started.body.authorizeUrl : null;
  expect(typeof authorizeUrl).toBe("string");
  if (typeof authorizeUrl !== "string") throw new Error("OAuth did not return an authorization URL.");
  const authorized = await fetch(authorizeUrl, { signal: AbortSignal.timeout(30_000) });
  expect(authorized.ok).toBe(true);
  expect(await cardDocument(world.app, "Check connection")).toBeTruthy();
  const connected = await probe.eventually(() => cardDocument(world.app), {
    within: 60_000, intervalMs: 1_000, label: "card confirms live OAuth authorization",
    until: text => text.includes("Connection ready"),
  });
  expect(connected).not.toContain("Check connection");
  expect(connected).not.toContain("Connect Notes");
  await user.screenshot();
  evidence.recordAssertionEvidence("The same card confirms authorization and removes connection actions", connected, connected.includes("Connection ready") && !connected.includes("Check connection"));
});
