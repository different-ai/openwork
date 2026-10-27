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

const WORKSPACE_SCRIPT = { url: new URL("../../evals/packages/labs/src/demo-workspace-mcp.mjs", import.meta.url), label: "demo-workspace-mcp", daytonaPort: 3990 };
/** A self-contained Node script started next to Den API: a local child process, or uploaded into the Den sandbox. */
export type DemoScript = { url: URL; label: string; daytonaPort: number; localPort?: number };

export type DemoWorkspace = {
  /** Where Den API reaches the servers: `${baseUrl}/<service>/mcp`. */
  baseUrl: string;
  /** Where this machine can read the live demo data (`/state`) and restore the seed (`POST /reset`), when reachable. */
  stateUrl: string | null;
};

async function waitForHealth(baseUrl: string, label: string, failed: () => string | null): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const failure = failed();
    if (failure) throw new Error(`${label} failed to start: ${failure}`);
    if (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`${label} did not become healthy at ${baseUrl}/health.`);
}

/** Starts a self-contained demo script next to Den API: a child process locally, or inside the Den sandbox on Daytona. */
export async function startDemoScript(stack: AsyncDisposableStack, den: Den, script: DemoScript, env: Record<string, string> = {}): Promise<DemoWorkspace> {
  if (den.placement?.kind === "daytona") {
    const running = await startScriptOnSandbox({
      sandbox: den.placement.sandboxId, label: script.label, port: script.daytonaPort,
      scriptSource: await readFile(fileURLToPath(script.url), "utf8"), env,
      log: (line) => console.error(`[${script.label}] ${line}`),
    });
    // The Den disposer may already have deleted the sandbox; then there is nothing left to stop.
    stack.defer(() => running.stop().catch(() => undefined));
    return { baseUrl: running.loopbackUrl, stateUrl: null };
  }
  const port = script.localPort ?? await allocateFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(script.url)], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), ...env },
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
  const file = fileURLToPath(script.url).split("/").at(-1) ?? script.label;
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: script.label, match: file });
  await waitForHealth(baseUrl, script.label, () => spawnError?.message ?? (child.exitCode !== null ? logs || `exited ${child.exitCode}` : null));
  return { baseUrl, stateUrl: `${baseUrl}/state` };
}

/** Adds one shared, no-auth MCP connection every member can use, with its tools exposed directly. */
export async function connectDemoServer(den: Den, key: string, name: string, url: string): Promise<void> {
  const result = await denFetch(den.ref, `/v1/mcp-connections/by-key/demo-${key}`, {
    method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({
      name, url, authType: "none", credentialMode: "shared", exposeDirectly: true,
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  if (!result.response.ok) throw new Error(`Could not add the demo ${name} connection: HTTP ${result.response.status} ${JSON.stringify(result.body)}`);
}

/** Starts the demo Slack, Notion, Linear, Google Calendar and Gmail servers. */
export async function bootDemoWorkspace(stack: AsyncDisposableStack, den: Den): Promise<DemoWorkspace> {
  return startDemoScript(stack, den, WORKSPACE_SCRIPT);
}

/** Adds each demo server to the org as a shared connection every member can use, with its tools exposed directly. */
export async function connectDemoWorkspace(den: Den, workspace: DemoWorkspace): Promise<void> {
  for (const service of DEMO_WORKSPACE_SERVICES) await connectDemoServer(den, service.key, service.name, `${workspace.baseUrl}/${service.key}/mcp`);
}
