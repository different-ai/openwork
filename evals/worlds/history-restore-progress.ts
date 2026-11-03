import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { prepareParityBinaries } from "../scripts/engine-parity-binaries.mjs";

const exec = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/history-restore-progress.ts", import.meta.url));

/** Real native-converted synthetic history, resumed by an isolated Electron app.
 * No UI/network response is fabricated: the dialog reads actual worker progress. */
export async function historyRestoreProgress(seed: Seed) {
  const resolved = await prepareParityBinaries(repoRoot);
  const v1 = Reflect.get(resolved, "OPENWORK_OPENCODE_BIN");
  const v2 = Reflect.get(resolved, "OPENWORK_OPENCODE2_BIN");
  if (typeof v1 !== "string" || typeof v2 !== "string") throw new Error("Pinned history engines were not resolved");
  const binaries = { OPENWORK_OPENCODE_BIN: v1, OPENWORK_OPENCODE2_BIN: v2 };
  const profile = seed.tmpPath("history-progress");
  const root = join(profile, "opencode-v2");
  const workspace = seed.tmpPath("History");
  await mkdir(workspace, { recursive: true });
  const { stdout } = await exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "prepare"], { cwd: repoRoot, timeout: 360_000, maxBuffer: 65536 });
  if (!stdout.includes('"sourceMessages":200000')) throw new Error("Synthetic native history was not arranged");
  const runtime = join(profile, "runtime.sqlite");
  await writeFile(join(dirname(runtime), "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: false,
    engineOrigin: "manual", v1HistoryCopyStartedAt: Date.now() }));
  // Hold only this fixture's verified migration worker after real commits so
  // desktop startup cannot race past the state to be captured. The helper checks
  // its open fixture DB and this worktree's worker command before every signal.
  const watcher = exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "watch"], { cwd: repoRoot, timeout: 200_000 });
  const watched = watcher.then(() => null, (error: unknown) => error);
  const app = await seed.desktop({ name: "history-progress", workspacePath: workspace, env: {
    ...binaries, OPENWORK_RUNTIME_DB: runtime, OPENCODE_DB: join(root, "v1.db"), OPENWORK_ENGINE_V2_PREVIEW: "",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "history-example/example", provider: { "history-example": {
      npm: "@ai-sdk/openai-compatible", name: "Example provider", options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "fixture-only" },
      models: { example: { name: "Example model", tool_call: true, limit: { context: 131072, output: 4096 } } },
    } } }),
  } }).catch(async (error: unknown) => {
    watcher.child.kill("SIGTERM");
    await exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "resume"], { cwd: repoRoot }).catch(() => undefined);
    throw error;
  });
  const watchError = await watched;
  if (watchError) throw new Error("The synthetic restore worker could not be held for capture");
  return {
    app,
    legacy: process.env.OPENWORK_HISTORY_SCREENSHOT_VARIANT === "before",
    async saveFrame(png: Uint8Array) {
      const output = process.env.OPENWORK_HISTORY_SCREENSHOT_OUTPUT;
      if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, png); }
    },
    async advance() {
      await exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "advance"], { cwd: repoRoot, timeout: 200_000 });
    },
    async [Symbol.asyncDispose]() {
      await exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "resume"], { cwd: repoRoot, timeout: 10_000 }).catch(() => undefined);
      await app.stop();
      await rm(profile, { recursive: true, force: true });
    },
    async counters() {
      const { stdout } = await exec("bun", [fixture, root, workspace, binaries.OPENWORK_OPENCODE2_BIN, "count"], { cwd: repoRoot, timeout: 10_000 });
      const value: unknown = JSON.parse(stdout);
      if (typeof value !== "object" || value === null || !("done" in value) || !("total" in value)) throw new Error("Invalid restoration counters");
      const count = (row: unknown) => typeof row === "object" && row !== null && "n" in row && typeof row.n === "number" ? row.n : 0;
      return { done: count(value.done), total: count(value.total) };
    },
    async status() {
      return seed.evalIn(app, browserScript(async () => {
        const port = localStorage.getItem("openwork.server.port");
        const token = localStorage.getItem("openwork.server.token");
        if (!port || !token) return null;
        const response = await fetch(`http://127.0.0.1:${port}/experimental/engine-v2-preview/status`, { headers: { Authorization: `Bearer ${token}` } });
        const result: unknown = await response.json();
        if (typeof result !== "object" || result === null || !("migration" in result)) return null;
        const migration = result.migration;
        if (typeof migration !== "object" || migration === null) return null;
        const number = (key: string) => typeof Reflect.get(migration, key) === "number" ? Number(Reflect.get(migration, key)) : 0;
        return { state: Reflect.get(migration, "state"), phase: Reflect.get(migration, "phase"),
          restored: number("restored"), restoreTotal: number("restoreTotal"), total: number("total") };
      }, []), { awaitPromise: true });
    },
    async activeControl() {
      return seed.evalIn(app, browserScript(() => {
        const element = document.activeElement;
        return { button: element?.tagName === "BUTTON", label: element?.textContent?.trim() ?? "" };
      }, []));
    },
    async modelSearch() {
      return seed.evalIn(app, browserScript(() => {
        for (const input of document.querySelectorAll('input[placeholder*="Search models"]')) {
          const box = input.getBoundingClientRect();
          if (box.width > 0 && box.height > 0) return input.getAttribute("placeholder");
        }
        return null;
      }, []));
    },
    async layoutHealthy() {
      return seed.evalIn(app, browserScript(() => {
        const dialog = document.querySelector('[data-testid="engine-migration-progress"]');
        if (!dialog) return { healthy: false, dialogs: 0, alerts: 0, width: 0, height: 0 };
        const box = dialog.getBoundingClientRect();
        const visible = (selector: string) => [...document.querySelectorAll(selector)].filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
        }).length;
        const dialogs = visible('[role="dialog"]');
        const alerts = visible('[role="alertdialog"]');
        return { healthy: box.width >= 300 && box.height >= 100 && box.x >= 0 && box.y >= 0
          && box.right <= innerWidth && box.bottom <= innerHeight && dialogs === 1 && alerts === 0,
          dialogs, alerts, width: box.width, height: box.height };
      }, []));
    },
  };
}
