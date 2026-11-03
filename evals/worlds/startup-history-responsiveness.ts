import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
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
  const app = await seed.desktop({ name: "startup-history", env: {
    ...binaries, OPENWORK_RUNTIME_DB: join(profile, "runtime.sqlite"), OPENCODE_DB: join(profile, "synthetic-v1.db"),
    OPENWORK_ENGINE_V2_PREVIEW: "", OPENCODE_DISABLE_MODELS_FETCH: "1",
  } });
  const logPath = app.handle.meta?.log;
  if (typeof logPath !== "string") throw new Error("The isolated Electron log is required for heartbeat evidence");
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
      // The isolated renderer owns its loopback token. Read only allowlisted
      // status and latency fields; never return the token or storage to the test.
      return seed.evalIn(app, browserScript(async () => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        if (!port || !token) throw new Error("Isolated host is not ready");
        const start = performance.now();
        const response = await fetch(`http://127.0.0.1:${port}/experimental/engine-v2-preview/status`, { headers: { Authorization: `Bearer ${token}` } });
        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null || !("migration" in data)) throw new Error("Invalid migration status");
        const migration = data.migration;
        if (typeof migration !== "object" || migration === null) throw new Error("Invalid copy status");
        return { http: response.status, apiMs: performance.now() - start, chatRouting: Reflect.get(data, "chatRouting") === true,
          state: String(Reflect.get(migration, "state")), imported: Number(Reflect.get(migration, "imported")), total: Number(Reflect.get(migration, "total")) };
      }, []), { awaitPromise: true });
    },
  };
}
