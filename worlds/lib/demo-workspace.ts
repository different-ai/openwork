import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "../../evals/packages/cdp/src/index.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { startScriptOnSandbox } from "../../evals/packages/hosts/src/index.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";

/**
 * Demo workspace connections for preview worlds: realistic Slack, Notion, Linear, Google Calendar and Gmail MCP
 * servers for the fictional Acme Robotics team (evals/packages/labs/src/demo-workspace-mcp.mjs). Reads and writes
 * stay in that process's memory, so what an agent writes in a demo can be read back right away. They are added
 * to the org as ordinary shared, no-auth MCP connections, so real connectors can still be added next to them.
 */
export const DEMO_WORKSPACE_SERVICES = [
  { key: "slack", name: "Slack" },
  { key: "notion", name: "Notion" },
  { key: "linear", name: "Linear" },
  { key: "google-calendar", name: "Google Calendar" },
  { key: "gmail", name: "Gmail" },
] as const;

const SCRIPT_URL = new URL("../../evals/packages/labs/src/demo-workspace-mcp.mjs", import.meta.url);
/** Fixed port inside a Daytona Den sandbox; locally a free port is allocated. */
const DAYTONA_PORT = 3990;

export type DemoWorkspace = {
  /** Where Den API reaches the servers: `${baseUrl}/<service>/mcp`. */
  baseUrl: string;
  /** Where this machine can read the live demo data (`/state`) and restore the seed (`POST /reset`), when reachable. */
  stateUrl: string | null;
};

async function waitForHealth(baseUrl: string, failed: () => string | null): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const failure = failed();
    if (failure) throw new Error(`Demo workspace MCP failed to start: ${failure}`);
    if (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`Demo workspace MCP did not become healthy at ${baseUrl}/health.`);
}

/** Starts the demo servers next to Den API: a child process locally, or inside the Den sandbox on Daytona. */
export async function bootDemoWorkspace(stack: AsyncDisposableStack, den: Den): Promise<DemoWorkspace> {
  if (den.placement?.kind === "daytona") {
    const script = await startScriptOnSandbox({
      sandbox: den.placement.sandboxId, label: "demo-workspace-mcp", port: DAYTONA_PORT,
      scriptSource: await readFile(fileURLToPath(SCRIPT_URL), "utf8"),
      log: (line) => console.error(`[demo-workspace] ${line}`),
    });
    // The Den disposer may already have deleted the sandbox; then there is nothing left to stop.
    stack.defer(() => script.stop().catch(() => undefined));
    return { baseUrl: script.loopbackUrl, stateUrl: null };
  }
  const port = await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(SCRIPT_URL)], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let spawnError: Error | undefined;
  child.on("error", (error) => { spawnError = error; });
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-4000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  stack.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: "demo-workspace-mcp", match: "demo-workspace-mcp.mjs" });
  await waitForHealth(baseUrl, () => spawnError?.message ?? (child.exitCode !== null ? logs || `exited ${child.exitCode}` : null));
  return { baseUrl, stateUrl: `${baseUrl}/state` };
}

/** Adds each demo server to the org as a shared connection every member can use, with its tools exposed directly. */
export async function connectDemoWorkspace(den: Den, workspace: DemoWorkspace): Promise<void> {
  const headers = { authorization: `Bearer ${den.admin.token}` };
  for (const service of DEMO_WORKSPACE_SERVICES) {
    const result = await denFetch(den.ref, `/v1/mcp-connections/by-key/demo-${service.key}`, {
      method: "PUT", headers,
      body: JSON.stringify({
        name: service.name, url: `${workspace.baseUrl}/${service.key}/mcp`,
        authType: "none", credentialMode: "shared", exposeDirectly: true,
        access: { orgWide: true, memberIds: [], teamIds: [] },
      }),
    });
    if (!result.response.ok) throw new Error(`Could not add the demo ${service.name} connection: HTTP ${result.response.status} ${JSON.stringify(result.body)}`);
  }
}
