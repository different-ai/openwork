import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { prepareParityBinaries } from "../scripts/engine-parity-binaries.mjs";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));

export async function startupHistoryResponsiveness(seed: Seed) {
  const binaries = await prepareParityBinaries(repo);
  const profile = seed.tmpPath("startup-history");
  const workspace = seed.tmpPath("Synthetic-history");
  await mkdir(workspace, { recursive: true });
  const { stdout } = await exec("bun", [fileURLToPath(new URL("./fixtures/startup-history.ts", import.meta.url)), profile, workspace], { cwd: repo, timeout: 120_000 });
  if (!stdout.includes('"sessions":320')) throw new Error("Synthetic large history was not prepared");
  const token = randomUUID();
  const hostToken = randomUUID();
  const tokenStore = join(profile, "synthetic-tokens.json");
  await writeFile(tokenStore, JSON.stringify({ version: 2, credentials: { clientToken: token, hostToken, ownerToken: null, updatedAt: 1 } }), { mode: 0o600 });
  const desktopProfile = join(profile, "desktop");
  const env = { ...binaries, OPENWORK_SERVER_TOKEN_STORE_PATH: tokenStore,
    OPENWORK_RUNTIME_DB: join(profile, "runtime.sqlite"), OPENCODE_DISABLE_MODELS_FETCH: "1" };
  // Arrange an existing desktop selection, not the server-only workspace registry.
  // This makes main and renderer join the same bootRuntimeForSelectedWorkspace.
  const workspaceState = join(profile, "workspace-state.json");
  await writeFile(workspaceState, JSON.stringify({ selectedId: "synthetic-history", activeId: "synthetic-history",
    workspaces: [{ id: "synthetic-history", name: "Synthetic history", path: workspace, kind: "local" }] }));
  const app = await seed.desktop({ name: "startup-history", profileDir: desktopProfile,
    env: { ...env, OPENWORK_DESKTOP_WORKSPACE_STATE_PATH: workspaceState,
      OPENCODE_DB: join(profile, "synthetic-v1.db"), OPENWORK_ENGINE_AUTO_UPGRADE: "1", OPENWORK_ENGINE_V2_PREVIEW: "" } });
  const logPath = app.handle.meta?.log;
  if (typeof logPath !== "string") throw new Error("The isolated Electron log is required for heartbeat evidence");
  // Testkit can attach while the bootstrap/recovery surface is interactive.
  // Wait for the actual runtime connection, not merely an actionable screen.
  let readyPort = 0;
  const deadline = Date.now() + 60_000;
  while (!readyPort && Date.now() < deadline) {
    readyPort = Number(await seed.evalIn(app, browserScript(() => localStorage.getItem("openwork.server.port"), [])));
    if (!readyPort) await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!readyPort) {
    const text = await seed.evalIn(app, browserScript(() => document.body.textContent, []));
    throw new Error(`Desktop bootstrap did not publish its runtime port in 60 seconds: ${text}`);
  }
  return {
    app,
    fixture: { sessions: 320, messages: 320, largePayloads: 4, largePayloadMiB: 64 },
    async timings() {
      const log = await readFile(logPath, "utf8");
      const records: Array<{ operation: string; phase: string; elapsedMs: number; hostMaxLagMs: number; hostStalls250ms: number; hostTicks: number }> = [];
      for (const line of log.split("\n")) {
        const start = line.indexOf('{"event":"history.preparation"');
        if (start < 0) continue;
        const value: unknown = JSON.parse(line.slice(start));
        if (typeof value !== "object" || value === null) continue;
        const field = (key: string) => Reflect.get(value, key);
        const operation = field("operation"); const phase = field("phase");
        const elapsedMs = field("elapsedMs"); const hostMaxLagMs = field("hostMaxLagMs");
        const hostStalls250ms = field("hostStalls250ms"); const hostTicks = field("hostTicks");
        if (typeof operation === "string" && typeof phase === "string" && typeof elapsedMs === "number"
          && typeof hostMaxLagMs === "number" && typeof hostStalls250ms === "number" && typeof hostTicks === "number") {
          records.push({ operation, phase, elapsedMs, hostMaxLagMs, hostStalls250ms, hostTicks });
        }
      }
      return records;
    },
    async status() {
      // Read only the fixture's loopback port. The token remains in this closure.
      // Use an independent HTTP client: renderer EventSources can exhaust the
      // browser's per-origin connection pool, which is not main-loop latency.
      const port = Number(await seed.evalIn(app, browserScript(() => localStorage.getItem("openwork.server.port"), [])));
      if (!Number.isSafeInteger(port) || port < 1) throw new Error(`Isolated host port is not ready: type=${typeof port}, value=${JSON.stringify(port)}`);
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${port}/experimental/engine-v2-preview/status`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000),
      });
      const data: unknown = await response.json();
      if (typeof data !== "object" || data === null || !("migration" in data)) throw new Error("Invalid migration status");
      const migration = data.migration;
      if (typeof migration !== "object" || migration === null) throw new Error("Invalid copy status");
      return { http: response.status, apiMs: performance.now() - start, chatRouting: Reflect.get(data, "chatRouting") === true,
        state: String(Reflect.get(migration, "state")), imported: Number(Reflect.get(migration, "imported")), total: Number(Reflect.get(migration, "total")) };
    },
  };
}
