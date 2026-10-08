import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { expect } from "vitest";
import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "@openwork/labs";
import { spec } from "@openwork/testkit";
import { engineParity } from "../worlds/engine-parity.ts";

const test = spec.world(engineParity, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const INITIALIZE_MS = 5_000;

/** A real MCP server that takes 5 s to answer every `initialize`, and counts the engine's starts. */
async function slowStartingConnection(notes: string) {
  const witness = await startMockMcp({
    port: await allocateFreePort(), allowUnauthenticatedMcp: true,
    tools: [{ name: "read_notes", description: "Read the member's latest notes", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: notes }] } }],
  });
  const clients: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body: unknown = raw ? JSON.parse(raw) : null;
      if (record(body) && body.method === "initialize") {
        const params = record(body.params) ? body.params : {};
        const info = record(params.clientInfo) ? params.clientInfo : {};
        // OpenWork's own health probe also opens a short-lived client; only
        // the engine's client (user agent opencode/…) is the member's connection.
        if (String(request.headers["user-agent"]).startsWith("opencode/")) clients.push(`${String(info.name)}@${String(info.version)}`);
        await new Promise((resolve) => setTimeout(resolve, INITIALIZE_MS));
      }
      const session = request.headers["mcp-session-id"];
      const upstream = await fetch(witness.mcpUrl, {
        method: request.method, body: raw || undefined, signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(typeof session === "string" ? { "mcp-session-id": session } : {}) },
      });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      response.end(await upstream.text());
    } catch {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    // OpenWork Cloud's connection lives at /mcp/agent.
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp/agent`,
    initializes: () => clients.length,
    async stop() { await new Promise((resolve) => server.close(resolve)); await witness.stop(); },
  };
}

// The desktop refreshes a member's connections every 5 minutes and whenever
// the window regains focus. On v2 that refresh used to restart every healthy
// connection, and a message sent meanwhile waited for the restarts or ran
// without the connection's tools.
test("a member sends a message right after OpenWork refreshes their connections, and the reply starts at once with the connection's tool working", { tags: ["user-flow"] }, async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  const listed = await world.request("/workspaces");
  const items = record(listed.body) && Array.isArray(listed.body.items) ? listed.body.items.filter(record) : [];
  const workspaceId = items.find((item) => item.path === world.workspacePath)?.id;
  if (typeof workspaceId !== "string") throw new Error("The fixture workspace is not listed");
  const workspace = `/workspace/${encodeURIComponent(workspaceId)}`;
  const notes = `Latest notes ${Date.now().toString(36)}`;
  const connection = await slowStartingConnection(notes);
  const refresh = () => world.request(`${workspace}/mcp/openwork-cloud/reconcile`, "POST", {
    config: { type: "remote", url: connection.url, enabled: true, oauth: false, headers: { Authorization: "Bearer eval-fixture" } }, trigger: "desktop-background",
  });
  const cloudStatus = async () => {
    const catalog = await world.request(`${workspace}/opencode2/api/mcp`);
    const entry = record(catalog.body) && Array.isArray(catalog.body.data)
      ? catalog.body.data.filter(record).find((item) => item.name === "openwork-cloud") : undefined;
    return entry && record(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "missing";
  };
  try {
    await step("before: the member's cloud connection, which takes 5 s to start, is connected", async () => {
      await refresh();
      await probe.eventually(cloudStatus, { within: 60_000, label: "the connection is connected", until: (status) => status === "connected" });
      await user.see("composer", { editable: true });
      await user.screenshot();
      evidence.recordAssertionEvidence("The connection is ready before the refresh",
        `status connected after ${connection.initializes()} start(s) of ${INITIALIZE_MS / 1000} s each`, connection.initializes() >= 1);
    });

    const startsBefore = connection.initializes();
    const prompt = `Summarize my latest notes. SEND-${Date.now().toString(36)}`;
    await world.prepareTurn(prompt, "The notes were not returned", [
      { tool: "execute", arguments: { code: 'return await tools["openwork-cloud"].read_notes({});' } },
    ], "last-tool-text");
    let firstTextMs = Number.POSITIVE_INFINITY;
    await step("the member types a message while OpenWork refreshes their connections in the background", async () => {
      void refresh().catch(() => undefined);
      // Give the refresh time to reach the engine (a restart shows up as a new start).
      await probe.eventually(async () => connection.initializes(), { within: 1_500, label: "refresh reached the engine", until: (count) => count > startsBefore })
        .catch(() => undefined);
      await user.type("composer", prompt);
      await user.screenshot();
    });

    await step("after: the reply starts within 2 s and contains what the connection's tool returned", async () => {
      const sent = performance.now();
      await user.click("Run task");
      await user.see({ text: notes }, { timeoutMs: 60_000 });
      firstTextMs = Math.round(performance.now() - sent);
      await user.screenshot();
      const restarts = connection.initializes() - startsBefore;
      evidence.recordAssertionEvidence("The reply is not held by connection upkeep",
        `${firstTextMs} ms from Run task to the reply showing the tool result "${notes}"; the refresh restarted the healthy connection ${restarts} time(s)`,
        firstTextMs < 2_000 && restarts === 0);
      expect(restarts).toBe(0);
      expect(firstTextMs).toBeLessThan(2_000);
    });

    await step("the connection is still connected afterwards, started only once", async () => {
      await user.see("Run task", { timeoutMs: 30_000 });
      const status = await cloudStatus();
      await user.screenshot();
      evidence.recordAssertionEvidence("The healthy connection stayed up", `status ${status}; ${connection.initializes()} start(s) in total`, status === "connected");
      expect(status).toBe("connected");
      expect(connection.initializes()).toBe(startsBefore);
    });
  } finally {
    await connection.stop();
  }
});
