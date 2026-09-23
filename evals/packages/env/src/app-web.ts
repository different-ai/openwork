import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { waitUntilInteractive } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";
import {
  chrome,
  prepareSandboxRepo,
  readSandboxRepoSourceReceipt,
  startMockOnSandbox,
} from "@openwork/hosts";
import type { SandboxRepoSourceReceipt } from "@openwork/hosts";
import { startLocalRuntime, startRemoteRuntime } from "./app-web-runtime.ts";
import type { AppWebRuntime } from "./app-web-runtime.ts";
import type { MockBoot, MockHandle } from "./mock.ts";
import type { Place } from "./place.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const MOCK_SCRIPT_PATH = join(REPO_ROOT, "scripts", "mock-oauth-mcp-server.mjs");

export interface SeedAppWebOptions {
  workspacePath: string;
  emptyWorkspace?: boolean;
  /** Explicit fixture runtime settings; the normal isolated environment is retained. */
  env?: Record<string, string>;
  syntheticPreactivatedDenOrigin?: string;
  name?: string;
  mocks?: Record<string, MockBoot>;
  headless?: boolean;
}

/** A test-owned real app-web stack. This is distinct from seed.web(), which drives Den. */
export interface AppWeb extends AttachedSurface {
  webUrl: string;
  openworkUrl: string;
  workspaceRoot: string;
  mocks: Record<string, MockHandle>;
  actualSourceSha: string | null;
  source: SandboxRepoSourceReceipt | null;
}

function safeWorldSegment(value: string): string {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join("-") || "app-web";
}

function attachAppWebMetadata(
  surface: AttachedSurface,
  metadata: Pick<AppWeb, "webUrl" | "openworkUrl" | "workspaceRoot" | "mocks" | "actualSourceSha" | "source">,
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
      runtime = await startRemoteRuntime(sandbox, worldName, workspaceRoot, source, { syntheticPreactivatedDenOrigin: options.syntheticPreactivatedDenOrigin, env: options.env, emptyWorkspace: options.emptyWorkspace });
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
      runtime = await startLocalRuntime(worldName, workspaceRoot, { syntheticPreactivatedDenOrigin: options.syntheticPreactivatedDenOrigin, env: options.env, emptyWorkspace: options.emptyWorkspace });
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
