import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { expect } from "vitest";
import { allocateFreePort } from "@openwork/cdp";
import { startMockMcp } from "@openwork/labs";
import { readTranscriptMessages, spec } from "@openwork/testkit";
import { engineParity } from "../worlds/engine-parity.ts";

const test = spec.world(engineParity, {
  timeout: 420_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { placement: "local", env: ["OPENWORK_EVAL_ENGINE"] },
});

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A real MCP server whose `initialize` handshake is held until released (at most 20 s). */
async function slowStartingMcp() {
  const witness = await startMockMcp({
    port: await allocateFreePort(), allowUnauthenticatedMcp: true,
    tools: [{ name: "ping", description: "Check the connection", inputSchema: { type: "object", properties: {} }, result: { content: [{ type: "text", text: "pong" }] } }],
  });
  let holding = false;
  let initializeSeen = false;
  let release = () => {};
  let held = Promise.resolve();
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body: unknown = raw ? JSON.parse(raw) : null;
      if (record(body) && body.method === "initialize") {
        initializeSeen = true;
        if (holding) await Promise.race([held, new Promise((resolve) => setTimeout(resolve, 20_000))]);
      }
      const upstream = await fetch(witness.mcpUrl, {
        method: request.method, body: raw || undefined, signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
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
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/mcp`;
  return {
    url,
    initializeSeen: () => initializeSeen,
    hold() { holding = true; held = new Promise<void>((resolve) => { release = resolve; }); },
    release() { holding = false; release(); },
    async stop() { release(); await new Promise((resolve) => server.close(resolve)); await witness.stop(); },
  };
}

// Matches v1: provider mirroring and MCP registration run when configuration
// changes; they never hold the engine's reads. Before this change every v2 read
// except history waited for the in-flight connection setup.
test("UPKEEP-01 v2: the conversation stays responsive while a new connection is still starting", async ({ world, user, probe, step, evidence }) => {
  expect(world.engine).toBe("v2");
  await probe.eventually(() => probe.composer(), { within: 60_000, label: "starter model ready", until: (state) => state.selectedModelLabel.includes("Big Pickle") && !state.modelUnavailable });
  const listed = await world.request("/workspaces");
  const items = record(listed.body) && Array.isArray(listed.body.items) ? listed.body.items.filter(record) : [];
  const workspaceId = items.find((item) => item.path === world.workspacePath)?.id;
  if (typeof workspaceId !== "string") throw new Error("The fixture workspace is not listed");
  const native = (path: string) => `/workspace/${encodeURIComponent(workspaceId)}/opencode2/api${path}`;
  const mcp = await slowStartingMcp();
  const timings: Record<string, number> = {};
  try {
    mcp.hold();
    const registration = world.request(`/workspace/${encodeURIComponent(workspaceId)}/mcp`, "POST", {
      name: "slow-start", config: { type: "remote", url: mcp.url },
    });
    await probe.eventually(async () => mcp.initializeSeen(), { within: 30_000, label: "the new connection's handshake is in progress", until: Boolean });
    await step("the running-session poll, permission poll and model list answer while the handshake is held", async () => {
      for (const path of ["/session/active", "/permission", "/model"]) {
        const started = performance.now();
        const response = await world.request(native(path));
        timings[path] = Math.round(performance.now() - started);
        expect({ path, status: response.status < 500 ? "answered" : response.status }).toEqual({ path, status: "answered" });
      }
      for (const [path, ms] of Object.entries(timings)) expect({ path, fast: ms < 5_000 }).toEqual({ path, fast: true });
    });
    mcp.release();
    expect((await registration).status).toBe(200);
    await step("a prompt still runs once the connection has started", async () => {
      await user.type("composer", world.prompt);
      await user.click("Run task");
      await user.see({ text: world.reply }, { timeoutMs: 60_000 });
      await user.see("Run task", { timeoutMs: 30_000 });
      expect(await readTranscriptMessages(probe, "assistant")).toHaveLength(1);
      await user.screenshot();
    });
  } finally {
    await mcp.stop();
  }
  evidence.recordAssertionEvidence("Reads never wait on connection setup",
    `While a new MCP connection's handshake was held, the running-session poll answered in ${timings["/session/active"]} ms, the permission poll in ${timings["/permission"]} ms and the model list in ${timings["/model"]} ms; after the connection started, a prompt ran normally.`, true);
});
