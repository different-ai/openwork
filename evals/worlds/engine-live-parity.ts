import { mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveEvalEngine, type Seed, type Place } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { readAvailableModels, selectModel } from "@openwork/behaviors";

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** No fake inference, scripted model, saved workspace, auth, preferences or history. */
export async function engineLiveParity(seed: Seed, { place }: { place: Place }) {
  const engine = resolveEvalEngine();
  const path = seed.tmpPath("live-workspace");
  await mkdir(path, { recursive: true });
  const workspacePath = await realpath(path);
  const proofPath = seed.tmpPath("live-proof.txt");
  const witnessPath = seed.tmpPath("live-mcp-calls.jsonl");
  await writeFile(proofPath, randomUUID());
  await writeFile(witnessPath, "");
  const app = await seed.appWeb({ name: "engine-live-parity", workspacePath, emptyWorkspace: true, env: {
    OPENWORK_LOG_FORMAT: "json",
    ...(process.env.OPENWORK_OPENCODE_BIN ? { OPENWORK_OPENCODE_BIN: process.env.OPENWORK_OPENCODE_BIN } : {}),
    ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
  } });
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!manifest) throw new Error("Missing owned runtime");
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${app.openworkUrl}${path}`, { method,
      headers: { Authorization: `Bearer ${manifest.token}`, "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60_000) });
    const value: unknown = await response.json();
    return { status: response.status, body: value };
  };
  return { app, engine, workspacePath, request,
    async messages() {
      const route = await seed.evalIn(app, () => location.hash || location.pathname);
      const match = /\/workspace\/([^/]+)\/session\/([^/?#]+)/.exec(route);
      if (!match) return [];
      const payload = (await request(`/workspace/${match[1]}/${engine === "v2" ? "opencode2/api" : "opencode"}/session/${match[2]}/message`)).body;
      return Array.isArray(payload) ? payload : record(payload) && Array.isArray(payload.data) ? payload.data : [];
    },
    mcpCommand: `${process.execPath} ${fileURLToPath(new URL("../fixtures/live-report-mcp.mjs", import.meta.url))} ${proofPath} ${witnessPath}`,
    async changeReport() { const code = randomUUID(); await writeFile(proofPath, code); return code; },
    async toolCalls() { return (await readFile(witnessPath, "utf8")).trim().split("\n").filter(Boolean).map(line => { const value: unknown = JSON.parse(line); return value; }); },
    readModels: () => readAvailableModels(app),
    selectModel: (id: string) => selectModel(app, id),
    route: () => seed.evalIn(app, () => location.hash || `#${location.pathname}`),
    documentIdentity: () => seed.evalIn(app, () => performance.timeOrigin),
    async reloadRequests() {
      const log = await readFile(paths.headlessLogPath, "utf8");
      return log.split("\n").filter(line => /Engine rollover requested|Engine reloaded in place|POST .*\/(?:engine\/reload|instance\/dispose|global\/dispose)/.test(line));
    },
  };
}
