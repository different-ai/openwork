import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { inferenceFixture, type InferenceRecord } from "./packaged-sandbox-fixtures.ts";
import { startMockMcp } from "@openwork/labs";
import { allocateFreePort } from "@openwork/cdp";

/** The engine and shell remain real; only the model's choice of tool is scripted. */
export async function uxScriptedInference() {
  const workloads = [
    { promptMarker: "Use the sandbox_shell tool to run exactly: uname -s.", tool: "sandbox_shell", command: "uname -s" },
    { promptMarker: "Use the shell tool to run exactly: uname -s.", tool: "shell", command: "uname -s" },
    { promptMarker: "Use shell to run exactly: sleep 25; uname -s.", tool: "shell", command: "sleep 25; uname -s" },
  ].map(({ promptMarker, tool, command }) => ({ promptMarker, latestUserTurn: true, finalReply: "Tool finished.", steps: [{ tool, arguments: { command, description: "Sandbox UX timing probe", timeout: 45_000 } }] }));
  const fixture = await startMockMcp({ port: await allocateFreePort(), isolatedProcessEnv: true, agentWorkloads: workloads });
  const records: InferenceRecord[] = [];
  const arrivals: { phase: string; path: string; ms: number; at: string }[] = [];
  return { url: `${fixture.url}/v1`, token: "local-scripted-ux", records, arrivals, close: () => fixture.stop() };
}

/** Signed-out loopback contract, based on sandboxDenFixture. Delay only the flag endpoint. */
export async function uxDenFixture(flag: boolean, delayMs: number, offline: boolean, delayAll = false) {
  const requests: { path: string; at: string; ms: number; method: string; status?: number; durationMs?: number }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname.replace(/^\/api\/den/, "");
    const entry: (typeof requests)[number] = { path, at: new Date().toISOString(), ms: performance.now(), method: request.method ?? "" };
    requests.push(entry);
    response.once("finish", () => { entry.status = response.statusCode; entry.durationMs = performance.now() - entry.ms; });
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "content-type": "application/json" };
    if (request.method === "OPTIONS") { response.writeHead(204, headers).end(); return; }
    const body = path === "/v1/features" ? { features: { sandboxTools: flag } }
      : path === "/v1/app-version" ? { minAppVersion: "0.0.0", latestAppVersion: "0.0.0", publishedDesktopVersions: [] } : null;
    void delay(delayAll || path === "/v1/features" ? delayMs : 0, undefined, { ref: false }).then(() => {
      if (!response.destroyed) response.writeHead(body ? 200 : 404, headers).end(JSON.stringify(body ?? { error: "fixture_not_found" }));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("No fixture port");
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  if (offline) await close();
  return { url: `http://127.0.0.1:${addr.port}`, requests, close };
}

/** Timestamp the existing proxy's validated request callback synchronously (after parsing its body). */
export async function timedInference(...args: Parameters<typeof inferenceFixture>) {
  const proxy = await inferenceFixture(...args);
  const arrivals: { phase: string; path: string; ms: number; at: string }[] = [];
  Object.defineProperty(proxy.records, "push", { value: (...entries: InferenceRecord[]) => {
    for (const { phase, path } of entries) arrivals.push({ phase, path, ms: performance.now(), at: new Date().toISOString() });
    return Array.prototype.push.apply(proxy.records, entries);
  } });
  return { ...proxy, arrivals };
}
