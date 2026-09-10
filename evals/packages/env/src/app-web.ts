import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { waitUntilInteractive } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import type { AttachedSurface, Surface } from "@openwork/cdp";
import {
  chrome,
  defaultDaytonaExec,
  execInSandbox,
  prepareSandboxRepo,
  readSandboxRepoSourceReceipt,
  startMockOnSandbox,
} from "@openwork/hosts";
import type { SandboxRepoSourceReceipt } from "@openwork/hosts";
import { launchHeadlessWeb, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { resolveEvalEngine } from "./eval-engine.ts";
import type { MockBoot, MockHandle } from "./mock.ts";
import type { Place } from "./place.ts";
import { provisionOwnedWorkspace, configureOwnedProviders } from "./app-web-workspace.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const REMOTE_REPO_ROOT = "/workspace";
const MOCK_SCRIPT_PATH = join(REPO_ROOT, "scripts", "mock-oauth-mcp-server.mjs");
const EXECUTABLE_ENV_KEYS = ["PATH", "PNPM_HOME", "TMPDIR", "SHELL", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR"];

export interface SeedAppWebOptions {
  workspacePath: string;
  name?: string;
  mocks?: Record<string, MockBoot>;
  headless?: boolean;
}

/** A test-owned real app-web stack. This is distinct from seed.web(), which drives Den. */
export interface AppWeb extends AttachedSurface {
  configureProviders(provider: Record<string, unknown>): Promise<void>;
  provisionWorkspace(folderPath: string): Promise<{ workspaceId: string }>;
  webUrl: string;
  openworkUrl: string;
  workspaceRoot: string;
  mocks: Record<string, MockHandle>;
  actualSourceSha: string | null;
  source: SandboxRepoSourceReceipt | null;
}

interface AppWebRuntime {
  configureProviders(provider: Record<string, unknown>): Promise<void>;
  provisionWorkspace(folderPath: string): Promise<{ workspaceId: string }>;
  webUrl: string;
  openworkUrl: string;
  runtimeDirectory: string;
  fixtureRoot: string;
  source: SandboxRepoSourceReceipt | null;
  stop(): Promise<void>;
}

function executableEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Executable discovery only: never copy provider keys, auth, or personal app state.
  for (const key of EXECUTABLE_ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

function isolatedRuntimeEnvironment(root: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const data = join(root, "data");
  const config = join(root, "config");
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(root, "cache"),
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
    OPENWORK_ENGINE_V2_PREVIEW: resolveEvalEngine() === "v2" ? "1" : "0",
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

function runtimeDirectories(root: string): string[] {
  return [
    "home",
    "cache",
    "config/openwork",
    "config/opencode",
    "data/openwork",
    "data/opencode",
    "state",
  ].map((path) => join(root, path));
}

function safeWorldSegment(value: string): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-") || "app-web";
}

export function isAppWeb(surface: Surface): surface is AppWeb {
  return "provisionWorkspace" in surface && typeof surface.provisionWorkspace === "function";
}

function attachAppWebMetadata(
  surface: AttachedSurface,
  metadata: Pick<AppWeb, "webUrl" | "openworkUrl" | "workspaceRoot" | "mocks" | "actualSourceSha" | "source" | "provisionWorkspace" | "configureProviders">,
  stop: () => Promise<void>,
): asserts surface is AppWeb {
  Object.assign(surface, metadata);
  surface[Symbol.asyncDispose] = stop;
  // Assign stop last so setup-error cleanup still sees Chrome's original
  // disposer if augmentation itself ever fails.
  surface.stop = stop;
}

function cleanupError(label: string, error: unknown): Error {
  return new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

async function cleanupMocks(mocks: Record<string, MockHandle>, errors: Error[]): Promise<void> {
  for (const [name, mock] of Object.entries(mocks)) {
    await mock.stop().catch((error: unknown) => errors.push(cleanupError(`Mock ${name} cleanup failed`, error)));
  }
}

async function cleanupAppWeb(input: {
  browserStop: (() => Promise<void>) | null;
  runtime: AppWebRuntime | null;
  mocks: Record<string, MockHandle>;
  remote: boolean;
}): Promise<void> {
  const errors: Error[] = [];
  let runtimeStopped = input.runtime === null;

  if (input.remote) {
    if (input.runtime) {
      try {
        await input.runtime.stop();
        runtimeStopped = true;
      } catch (error) {
        errors.push(cleanupError("Remote headless app runtime cleanup failed; ownership manifest preserved", error));
      }
    }
    await cleanupMocks(input.mocks, errors);
    // A newly provisioned placement deletes its sandbox when Chrome is disposed.
    // Keep that sandbox and its manifest intact when the owned runtime did not stop.
    if (runtimeStopped && input.browserStop) {
      await input.browserStop().catch((error: unknown) => errors.push(cleanupError("Chrome cleanup failed", error)));
    }
  } else {
    if (input.browserStop) {
      await input.browserStop().catch((error: unknown) => errors.push(cleanupError("Chrome cleanup failed", error)));
    }
    if (input.runtime) {
      try {
        await input.runtime.stop();
        runtimeStopped = true;
      } catch (error) {
        errors.push(cleanupError("Headless app runtime cleanup failed; ownership manifest preserved", error));
      }
    }
    await cleanupMocks(input.mocks, errors);
    if (runtimeStopped && input.runtime) {
      for (const path of [input.runtime.runtimeDirectory, input.runtime.fixtureRoot]) {
        await rm(path, { recursive: true, force: true })
          .catch((error: unknown) => errors.push(cleanupError(`Temporary path cleanup failed for ${path}`, error)));
      }
    }
  }

  if (errors.length > 0) throw new AggregateError(errors, "Hermetic app-web cleanup failed");
}

async function startLocalRuntime(worldName: string, workspaceRoot: string): Promise<AppWebRuntime> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openwork-eval-app-web-"));
  const runtimeDirectory = resolveHeadlessWorldRuntimePaths(REPO_ROOT, worldName).directory;
  try {
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      ...runtimeDirectories(fixtureRoot).map((path) => mkdir(path, { recursive: true })),
    ]);
    workspaceRoot = await realpath(workspaceRoot);
    const runtime = await launchHeadlessWeb({
      repoRoot: REPO_ROOT,
      name: worldName,
      state: "isolated",
      workspace: workspaceRoot,
      env: { ...executableEnvironment(process.env), ...isolatedRuntimeEnvironment(fixtureRoot) },
    });
    return {
      webUrl: runtime.manifest.webUrl,
      provisionWorkspace: (folderPath) => provisionOwnedWorkspace(runtime.manifest, folderPath),
      configureProviders: (provider) => configureOwnedProviders(runtime.manifest, provider),
      openworkUrl: runtime.manifest.openworkUrl,
      runtimeDirectory,
      fixtureRoot,
      source: null,
      stop: () => runtime.stop(),
    };
  } catch (error) {
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function parseRemoteRuntime(output: string): Pick<AppWebRuntime, "webUrl" | "openworkUrl"> & { runtimeManifestPath: string } {
  const line = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Remote app-web launcher did not return a JSON receipt. Output tail: ${output.slice(-1_000)}`);
  }
  if (typeof value !== "object" || value === null
    || !("webUrl" in value) || typeof value.webUrl !== "string"
    || !("openworkUrl" in value) || typeof value.openworkUrl !== "string"
    || !("runtimeManifestPath" in value) || typeof value.runtimeManifestPath !== "string") {
    throw new Error("Remote app-web launcher returned an invalid receipt.");
  }
  return { webUrl: value.webUrl, openworkUrl: value.openworkUrl, runtimeManifestPath: value.runtimeManifestPath };
}

function assertLoopbackRuntimeUrl(label: string, value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port) {
    throw new Error(`${label} must be a sandbox-loopback HTTP URL, received ${JSON.stringify(value)}.`);
  }
}

async function runRemoteModule(
  sandbox: string,
  modulePath: string,
  source: string,
  payload: unknown,
  context: string,
  timeoutMs: number,
): Promise<string> {
  const encodedSource = Buffer.from(source, "utf8").toString("base64");
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const result = await execInSandbox(
    defaultDaytonaExec,
    sandbox,
    `printf %s ${encodedSource} | base64 -d > ${modulePath}; node ${modulePath} ${encodedPayload}`,
    { context, timeoutMs },
  );
  return result.stdout;
}

const REMOTE_LAUNCH_SOURCE = `
import { constants } from "node:fs";
import { access, mkdir, readdir, symlink } from "node:fs/promises";
import { launchHeadlessWeb } from "/workspace/packages/world/src/headless-web.ts";
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
const handle = await launchHeadlessWeb({
  repoRoot: input.repoRoot,
  name: input.name,
  state: "isolated",
  workspace: input.workspace,
  env: { ...executable, ...input.env },
});
await handle.detach();
console.log(JSON.stringify({
  webUrl: handle.manifest.webUrl,
  openworkUrl: handle.manifest.openworkUrl,
  runtimeManifestPath: handle.manifest.runtimeManifestPath,
}));
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

const REMOTE_WORKSPACE_SOURCE = `
import { readHeadlessRuntimeManifest } from "/workspace/packages/world/src/headless-web.ts";
import { provisionOwnedWorkspace, configureOwnedProviders } from "/workspace/evals/packages/env/src/app-web-workspace.ts";
const input = JSON.parse(Buffer.from(process.argv[2], "base64url").toString("utf8"));
const manifest = await readHeadlessRuntimeManifest(input.runtimeManifestPath);
if (!manifest || manifest.openworkUrl !== input.openworkUrl) throw new Error("Owned app-web manifest mismatch");
if (input.operation === "providers") {
  await configureOwnedProviders(manifest, input.provider);
  console.log(JSON.stringify({ ok: true }));
} else console.log(JSON.stringify(await provisionOwnedWorkspace(manifest, input.folderPath)));
`;

async function startRemoteRuntime(
  sandbox: string,
  worldName: string,
  workspaceRoot: string,
  source: SandboxRepoSourceReceipt,
): Promise<AppWebRuntime> {
  const fixtureRoot = `/tmp/openwork-eval-app-web-${worldName}`;
  const runtimeDirectory = posix.join(REMOTE_REPO_ROOT, "tmp", "worlds", "runtime", worldName);
  const launchModulePath = `/tmp/${worldName}-launch.mjs`;
  const stopModulePath = `/tmp/${worldName}-stop.mjs`;
  const workspaceModulePath = `/tmp/${worldName}-workspace.mjs`;
  const output = await runRemoteModule(sandbox, launchModulePath, REMOTE_LAUNCH_SOURCE, {
    directories: [workspaceRoot, ...runtimeDirectories(fixtureRoot)],
    env: isolatedRuntimeEnvironment(fixtureRoot),
    executableEnvKeys: EXECUTABLE_ENV_KEYS,
    fixtureRoot,
    name: worldName,
    repoRoot: REMOTE_REPO_ROOT,
    workspace: workspaceRoot,
  }, `launch remote app-web runtime ${worldName}`, 120_000);
  const receipt = parseRemoteRuntime(output);
  const expectedManifest = posix.join(runtimeDirectory, "runtime.json");
  if (receipt.runtimeManifestPath !== expectedManifest) {
    throw new Error(`Remote app-web runtime manifest mismatch: expected ${expectedManifest}, received ${receipt.runtimeManifestPath}.`);
  }
  assertLoopbackRuntimeUrl("Remote app-web webUrl", receipt.webUrl);
  assertLoopbackRuntimeUrl("Remote app-web openworkUrl", receipt.openworkUrl);
  return {
    webUrl: receipt.webUrl,
    configureProviders: async (provider) => {
      const output = await runRemoteModule(sandbox, workspaceModulePath, REMOTE_WORKSPACE_SOURCE, {
        runtimeManifestPath: receipt.runtimeManifestPath, openworkUrl: receipt.openworkUrl, operation: "providers", provider,
      }, `configure owned app-web providers ${worldName}`, 150_000);
      const value: unknown = JSON.parse(output.trim());
      if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) throw new Error("Owned provider configuration was not acknowledged.");
    },
    provisionWorkspace: async (folderPath) => {
      const output = await runRemoteModule(sandbox, workspaceModulePath, REMOTE_WORKSPACE_SOURCE, {
        runtimeManifestPath: receipt.runtimeManifestPath, openworkUrl: receipt.openworkUrl, folderPath,
      }, `provision owned app-web workspace ${worldName}`, 60_000);
      const value: unknown = JSON.parse(output.trim());
      if (typeof value !== "object" || value === null || !("workspaceId" in value) || typeof value.workspaceId !== "string") {
        throw new Error("Owned remote workspace provisioning returned no identity.");
      }
      return { workspaceId: value.workspaceId };
    },
    openworkUrl: receipt.openworkUrl,
    runtimeDirectory,
    fixtureRoot,
    source,
    stop: async () => {
      await runRemoteModule(sandbox, stopModulePath, REMOTE_STOP_SOURCE, {
        runtimeManifestPath: receipt.runtimeManifestPath,
        remove: [runtimeDirectory, fixtureRoot, launchModulePath, stopModulePath, workspaceModulePath],
      }, `stop remote app-web runtime ${worldName}`, 60_000);
    },
  };
}

async function bootLocalMocks(place: Place, definitions: Record<string, MockBoot>): Promise<Record<string, MockHandle>> {
  const mocks: Record<string, MockHandle> = {};
  try {
    for (const [name, definition] of Object.entries(definitions)) {
      const booted = await definition.boot(place);
      mocks[name] = booted.handle;
    }
    return mocks;
  } catch (error) {
    const failures: unknown[] = [error];
    for (const mock of Object.values(mocks)) await mock.stop().catch((failure: unknown) => failures.push(failure));
    if (failures.length > 1) throw new AggregateError(failures, "Local mock setup and cleanup failed");
    throw error;
  }
}

async function bootRemoteMocks(
  sandbox: string,
  definitions: Record<string, MockBoot>,
): Promise<Record<string, MockHandle>> {
  const mocks: Record<string, MockHandle> = {};
  const scriptSource = await readFile(MOCK_SCRIPT_PATH, "utf8");
  const sourceFingerprint = createHash("sha256").update(scriptSource).digest("hex");
  try {
    for (const [name, definition] of Object.entries(definitions)) {
      if (!definition.daytonaPort || !definition.connect) {
        throw new Error(`Mock ${JSON.stringify(name)} does not support co-located Daytona placement.`);
      }
      const remote = await startMockOnSandbox({
        sandbox,
        port: definition.daytonaPort,
        allowUnauthenticatedMcp: definition.allowUnauthenticatedMcp,
        appToolName: definition.appToolName,
        scriptSource,
        sourceFingerprint,
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      });
      let booted: Awaited<ReturnType<NonNullable<MockBoot["connect"]>>>;
      try {
        booted = await definition.connect(remote.url);
      } catch (error) {
        await remote.stop().catch(() => undefined);
        throw error;
      }
      const handle = booted.handle;
      const stopConnected = handle.stop.bind(handle);
      let stopped = false;
      const stop = async (): Promise<void> => {
        if (stopped) return;
        stopped = true;
        const failures: unknown[] = [];
        await stopConnected().catch((error: unknown) => failures.push(error));
        await remote.stop().catch((error: unknown) => failures.push(error));
        if (failures.length > 0) throw new AggregateError(failures, `Remote mock ${name} cleanup failed`);
      };
      // Control methods keep their public-preview closure, while app/engine
      // configuration sees the co-located sandbox loopback endpoint.
      handle.url = remote.loopbackUrl;
      handle.mcpUrl = `${remote.loopbackUrl}/mcp`;
      handle.stop = stop;
      handle[Symbol.asyncDispose] = stop;
      mocks[name] = handle;
    }
    return mocks;
  } catch (error) {
    const failures: unknown[] = [error];
    for (const mock of Object.values(mocks)) await mock.stop().catch((failure: unknown) => failures.push(failure));
    if (failures.length > 1) throw new AggregateError(failures, "Remote mock setup and cleanup failed");
    throw error;
  }
}

/** Real Vite app + managed openwork-server + fresh Chrome, co-located on Daytona. */
export async function appWeb(options: SeedAppWebOptions & { place: Place }): Promise<AppWeb> {
  const workspaceRoot = options.workspacePath;
  const worldName = `${safeWorldSegment(options.name ?? "app-web")}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const remote = options.place.kind === "daytona";
  let runtime: AppWebRuntime | null = null;
  let browser: AttachedSurface | null = null;
  let mocks: Record<string, MockHandle> = {};
  let source: SandboxRepoSourceReceipt | null = null;
  let localSourceSha: string | null = null;
  try {
    if (remote) {
      const repoSource = options.place.denBase();
      if (repoSource.kind !== "daytona") throw new Error("Daytona app-web placement did not expose a source ref.");
      const preparedSandbox = process.env.OPENWORK_EVAL_DAYTONA_DESKTOP_SANDBOX?.trim();
      if (preparedSandbox) {
        // A supplied/borrowed room bypasses DaytonaPlacementHost provisioning,
        // so enforce its checkout before Chrome or either app process starts.
        source = await prepareSandboxRepo({
          sandbox: preparedSandbox,
          ref: repoSource.ref,
          log: (line) => console.error(`[openwork/testkit] ${line}`),
        });
      }
      browser = await chrome({
        name: worldName,
        host: options.place.host(),
        startUrl: "about:blank",
        headless: options.headless ?? true,
      });
      if (browser.handle.kind !== "chrome") throw new Error("App-web requires a chrome handle.");
      const sandbox = browser.handle.sandboxId;
      if (browser.handle.hostKind !== "daytona" || !sandbox) {
        throw new Error("Daytona app-web Chrome did not expose its owning sandbox.");
      }
      if (preparedSandbox && sandbox !== preparedSandbox) {
        throw new Error(`Daytona app-web prepared sandbox mismatch: guarded ${preparedSandbox}, Chrome owns ${sandbox}.`);
      }
      // Newly provisioned placements prepare source before spawning Chrome and
      // persist this receipt. Supplied placements use the in-memory receipt
      // from the preboot gate above.
      source ??= await readSandboxRepoSourceReceipt({ sandbox, expectedRef: repoSource.ref });
      browser.handle.meta = {
        ...browser.handle.meta,
        requestedSourceRef: source.requestedRef,
        expectedSourceSha: source.expectedSha,
        actualSourceSha: source.actualSha,
        sourcePreparedFingerprint: source.preparedFingerprint,
      };
      mocks = await bootRemoteMocks(sandbox, options.mocks ?? {});
      runtime = await startRemoteRuntime(sandbox, worldName, workspaceRoot, source);
      await navigate(browser.client, runtime.webUrl);
    } else {
      // Capture only the commit identity, before mocks or app processes launch.
      // Do not expose git stderr, checkout paths, or environment in evidence.
      try {
        const receipt = await promisify(execFile)("git", ["rev-parse", "--verify", "HEAD"], {
          cwd: REPO_ROOT,
          encoding: "utf8",
          timeout: 10_000,
        });
        localSourceSha = receipt.stdout.trim();
      } catch {
        throw new Error("Could not capture local app-web source SHA before launch.");
      }
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(localSourceSha)) {
        throw new Error("Invalid local app-web source SHA receipt.");
      }
      mocks = await bootLocalMocks(options.place, options.mocks ?? {});
      runtime = await startLocalRuntime(worldName, workspaceRoot);
      browser = await chrome({
        name: worldName,
        host: options.place.host(),
        startUrl: runtime.webUrl,
        headless: options.headless ?? true,
      });
      if (browser.handle.kind !== "chrome") throw new Error("App-web requires a chrome handle.");
      browser.handle.meta = { ...browser.handle.meta, actualSourceSha: localSourceSha };
    }
    await waitUntilInteractive(browser, { timeoutMs: 60_000 });

    const originalBrowserStop = browser.stop.bind(browser);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      await cleanupAppWeb({ browserStop: originalBrowserStop, runtime, mocks, remote });
    };
    attachAppWebMetadata(browser, {
      configureProviders: async (provider) => {
        if (stopped || !runtime) throw new Error("Owned app-web runtime has stopped.");
        await runtime.configureProviders(provider);
      },
      provisionWorkspace: async (folderPath) => {
        if (stopped || !runtime) throw new Error("Owned app-web runtime has stopped.");
        return runtime.provisionWorkspace(folderPath);
      },
      webUrl: runtime.webUrl,
      openworkUrl: runtime.openworkUrl,
      workspaceRoot,
      mocks,
      actualSourceSha: runtime.source?.actualSha ?? localSourceSha,
      source: runtime.source,
    }, stop);
    return browser;
  } catch (error) {
    try {
      await cleanupAppWeb({
        browserStop: browser ? browser.stop.bind(browser) : null,
        runtime,
        mocks,
        remote,
      });
    } catch (cleanupFailure) {
      throw new AggregateError([error, cleanupFailure], "Hermetic app-web setup and cleanup failed");
    }
    throw error;
  }
}
