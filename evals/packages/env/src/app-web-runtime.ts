import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { SandboxRepoSourceReceipt } from "@openwork/hosts";
import { launchHeadlessWeb, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { resolveEvalEngine, type EvalEngine } from "./eval-engine.ts";
import { seedSyntheticPreactivatedDen } from "./app-web-bootstrap.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const EXECUTABLE_ENV_KEYS = ["PATH", "PNPM_HOME", "TMPDIR", "SHELL", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "npm_execpath", "npm_node_execpath"];

export interface AppWebRuntime {
  webUrl: string;
  openworkUrl: string;
  runtimeDirectory: string;
  fixtureRoot: string;
  source: SandboxRepoSourceReceipt | null;
  stop(): Promise<void>;
}

export interface AppWebRuntimeOptions {
  engine?: EvalEngine;
  den?: { apiUrl: string; webUrl: string };
  webPort?: number;
  emptyWorkspace?: boolean;
  syntheticPreactivatedDenOrigin?: string;
  env?: Record<string, string>;
  browserHostSuffix?: string;
}

function executableEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of EXECUTABLE_ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

export function isolatedRuntimeEnvironment(root: string, engine: EvalEngine = resolveEvalEngine()): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const data = join(root, "data");
  const config = join(root, "config");
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(root, "cache"),
    // Fresh app instances must not rewrite another Vite server's dependency
    // cache while its browser is importing modules.
    OPENWORK_VITE_CACHE_DIR: join(root, "cache", "vite"),
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: join(root, "state"),
    OPENWORK_DATA_DIR: join(data, "openwork"),
    OPENWORK_ENV_STORE: join(config, "openwork", "env.json"),
    OPENWORK_SERVER_STATE_PATH: join(data, "openwork", "server-state.json"),
    OPENWORK_SERVER_TOKEN_STORE_PATH: join(data, "openwork", "server-tokens.json"),
    OPENCODE_CONFIG_DIR: join(config, "opencode"),
    OPENCODE_DB: join(data, "opencode", "opencode.db"),
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "0",
    OPENWORK_ENGINE_V2_PREVIEW: engine === "v2" ? "1" : "0",
    OPENWORK_PORT: "0",
    OPENWORK_WEB_PORT: "0",
    OPENWORK_REMOTE_ACCESS: "0",
    HOST: "127.0.0.1",
    VITE_HOST: "127.0.0.1",
    VITE_DISABLE_OPENWORK_MODELS: "1",
    VITE_OPENWORK_POSTHOG_KEY: "",
    VITE_OPENWORK_SENTRY_DSN: "",
    NO_PROXY: "127.0.0.1,localhost",
  };
}

export function appWebDenEnvironment(den?: AppWebRuntimeOptions["den"]): Record<string, string> {
  if (!den) return {};
  for (const address of [den.apiUrl, den.webUrl]) {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("App-web Den addresses must be HTTP(S) URLs without credentials, query or fragment");
    }
  }
  return { VITE_DEN_API_BASE_URL: den.apiUrl, VITE_DEN_BASE_URL: den.webUrl };
}

function runtimeDirectories(root: string): string[] {
  return ["home", "cache", "config/openwork", "config/opencode", "data/openwork", "data/opencode", "state"].map((path) => join(root, path));
}

export async function startLocalRuntime(worldName: string, workspaceRoot: string, options: AppWebRuntimeOptions = {}): Promise<AppWebRuntime> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openwork-eval-app-web-"));
  const runtimeDirectory = resolveHeadlessWorldRuntimePaths(REPO_ROOT, worldName).directory;
  try {
    await Promise.all([mkdir(workspaceRoot, { recursive: true }), ...runtimeDirectories(fixtureRoot).map((path) => mkdir(path, { recursive: true }))]);
    const bootstrapEnv = await seedSyntheticPreactivatedDen(fixtureRoot, options.syntheticPreactivatedDenOrigin);
    const runtime = await launchHeadlessWeb({
      repoRoot: REPO_ROOT,
      name: worldName,
      state: "isolated",
      workspace: workspaceRoot,
      emptyWorkspace: options.emptyWorkspace,
      browserHostSuffix: options.browserHostSuffix,
      env: { ...executableEnvironment(process.env), ...isolatedRuntimeEnvironment(fixtureRoot, options.engine), ...options.env, ...(options.webPort ? { OPENWORK_WEB_PORT: String(options.webPort) } : {}), ...appWebDenEnvironment(options.den), ...bootstrapEnv },
    });
    return { webUrl: runtime.manifest.webUrl, openworkUrl: runtime.manifest.openworkUrl, runtimeDirectory, fixtureRoot, source: null, stop: () => runtime.stop() };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseRemoteRuntime(output: string): Pick<AppWebRuntime, "webUrl" | "openworkUrl"> & { runtimeManifestPath: string } {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("Remote app-web launcher did not return a JSON receipt."); }
  if (typeof value !== "object" || value === null
    || !("webUrl" in value) || typeof value.webUrl !== "string"
    || !("openworkUrl" in value) || typeof value.openworkUrl !== "string"
    || !("runtimeManifestPath" in value) || typeof value.runtimeManifestPath !== "string") {
    throw new Error("Remote app-web launcher returned an invalid receipt.");
  }
  for (const url of [new URL(value.webUrl), new URL(value.openworkUrl)]) {
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.username || url.password) {
      throw new Error("Remote app-web runtime URLs must be sandbox-loopback HTTP URLs.");
    }
  }
  return { webUrl: value.webUrl, openworkUrl: value.openworkUrl, runtimeManifestPath: value.runtimeManifestPath };
}

async function runRemoteModule(sandbox: string, modulePath: string, source: string, payload: unknown, context: string, timeoutMs: number): Promise<string> {
  const encodedSource = Buffer.from(source, "utf8").toString("base64");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  try {
    const result = await execInSandbox(defaultDaytonaExec, sandbox,
      `umask 077; printf %s ${encodedSource} | base64 -d > ${modulePath}; node ${modulePath} ${encodedPayload}`,
      { context, timeoutMs });
    return result.stdout;
  } catch {
    throw new Error(`Remote app-web module failed during ${context}; inspect the owned sandbox's private runtime logs.`);
  }
}

const REMOTE_LAUNCH_SOURCE = `
import { constants } from "node:fs";
import { access, mkdir, readdir, symlink } from "node:fs/promises";
import { launchHeadlessWeb } from "/workspace/packages/world/src/headless-web.ts";
import { seedSyntheticPreactivatedDen } from "/workspace/evals/packages/env/src/app-web-bootstrap.ts";
const input = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
await Promise.all(input.directories.map((path) => mkdir(path, { recursive: true })));
const executable = {};
for (const key of input.executableEnvKeys) if (process.env[key]) executable[key] = process.env[key];
const toolBin = input.fixtureRoot + "/bin";
await mkdir(toolBin, { recursive: true });
const versionsRoot = "/usr/local/share/nvm/versions/node";
const versions = await readdir(versionsRoot).catch(() => []);
for (const tool of ["bun", "opencode"]) {
  for (const version of versions.sort().reverse()) {
    const source = versionsRoot + "/" + version + "/bin/" + tool;
    if (!await access(source, constants.X_OK).then(() => true, () => false)) continue;
    await symlink(source, toolBin + "/" + tool).catch(() => undefined);
    break;
  }
}
executable.PATH = [toolBin, executable.PATH].filter(Boolean).join(":");
const bootstrapEnv = await seedSyntheticPreactivatedDen(input.fixtureRoot, input.syntheticPreactivatedDenOrigin);
const handle = await launchHeadlessWeb({
  repoRoot: input.repoRoot, name: input.name, state: "isolated", workspace: input.workspace, emptyWorkspace: input.emptyWorkspace,
  browserHostSuffix: input.browserHostSuffix, env: { ...executable, ...input.env, ...bootstrapEnv },
});
await handle.detach();
console.log(JSON.stringify({ webUrl: handle.manifest.webUrl, openworkUrl: handle.manifest.openworkUrl, runtimeManifestPath: handle.manifest.runtimeManifestPath }));
`;

const REMOTE_STOP_SOURCE = `
import { rm } from "node:fs/promises";
import { readHeadlessRuntimeManifest, stopHeadlessRuntime } from "/workspace/packages/world/src/headless-web.ts";
const input = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const manifest = await readHeadlessRuntimeManifest(input.runtimeManifestPath);
if (!manifest) throw new Error("Owned remote app-web runtime manifest is missing");
await stopHeadlessRuntime(manifest);
await Promise.all(input.remove.map((path) => rm(path, { recursive: true, force: true })));
`;

export async function startRemoteRuntime(sandbox: string, worldName: string, workspaceRoot: string, source: SandboxRepoSourceReceipt, options: AppWebRuntimeOptions = {}): Promise<AppWebRuntime> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(worldName)) throw new Error("Unsafe app-web runtime name.");
  const fixtureRoot = `/tmp/openwork-eval-app-web-${worldName}`;
  const runtimeDirectory = posix.join("/workspace", "tmp", "worlds", "runtime", worldName);
  const launchModulePath = `/tmp/${worldName}-launch.mjs`;
  const stopModulePath = `/tmp/${worldName}-stop.mjs`;
  const output = await runRemoteModule(sandbox, launchModulePath, REMOTE_LAUNCH_SOURCE, {
    syntheticPreactivatedDenOrigin: options.syntheticPreactivatedDenOrigin,
    emptyWorkspace: options.emptyWorkspace,
    directories: [workspaceRoot, ...runtimeDirectories(fixtureRoot)],
    env: { ...isolatedRuntimeEnvironment(fixtureRoot, options.engine), ...options.env, ...(options.webPort ? { OPENWORK_WEB_PORT: String(options.webPort) } : {}), ...appWebDenEnvironment(options.den) },
    executableEnvKeys: EXECUTABLE_ENV_KEYS,
    fixtureRoot, name: worldName, repoRoot: "/workspace", workspace: workspaceRoot, browserHostSuffix: options.browserHostSuffix,
  }, `launch remote app-web runtime ${worldName}`, 120_000);
  const receipt = parseRemoteRuntime(output);
  if (receipt.runtimeManifestPath !== posix.join(runtimeDirectory, "runtime.json")) throw new Error("Remote app-web runtime manifest mismatch.");
  return {
    webUrl: receipt.webUrl, openworkUrl: receipt.openworkUrl, runtimeDirectory, fixtureRoot, source,
    stop: async () => {
      await runRemoteModule(sandbox, stopModulePath, REMOTE_STOP_SOURCE, {
        runtimeManifestPath: receipt.runtimeManifestPath,
        remove: [runtimeDirectory, fixtureRoot, launchModulePath, stopModulePath],
      }, `stop remote app-web runtime ${worldName}`, 60_000);
    },
  };
}
