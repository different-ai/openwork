import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize, sep } from "node:path";
import { promisify } from "node:util";
import { quitDesktop } from "@openwork/behaviors";
import { attachSurface, evaluateOnSurface } from "@openwork/cdp";
import type { AttachedSurface, SurfaceHandle } from "@openwork/cdp";
import { SkipError } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { localHost } from "@openwork/hosts";
import type { ElectronSurfaceOptions } from "@openwork/hosts";
import { updaterActivityFromLog } from "./packaged-preactivation-updater.ts";
import type { UpdaterActivity } from "./packaged-preactivation-updater.ts";
import type { RendererException } from "./packaged-first-launch.ts";
import {
  appBundleOf,
  observeRendererExceptions,
  pristineCopy,
  readActivation,
  readBuildInfo,
  waitForShipItIdle,
  waitUntilGone,
  withElectronBinary,
} from "./released-enterprise-activated.ts";
import type { AppBuildInfo } from "./released-enterprise-activated.ts";

/**
 * An activated enterprise install on macOS that finds a newer build on its
 * release feed, downloads it, hands it to Squirrel.Mac, and is quit. The
 * journey then relaunches the same bundle on the same profile.
 *
 * Everything the update touches is owned here: the feed is
 * OPENWORK_EVAL_UPDATE_FEED_DIR (an `enterprise-mac.yml` beside a zip of a
 * newer build signed by the same identity, which packaged-smoke-macos.mjs
 * produces) served on loopback, and the desktop is pointed at it through
 * OPENWORK_EVAL_UPDATE_FEED_URL. A loopback stand-in for the organization's
 * Den answers `/v1/app-version` with the feed's version, which is what lets
 * the renderer allow the download. The installed bundle is a private copy,
 * so the artifact under test is never modified.
 */

const MANIFEST = "enterprise-mac.yml";
const execFileAsync = promisify(execFile);

export interface ServedRequest {
  method: string;
  path: string;
  status: number;
}

export interface UpdateLaunch extends AsyncDisposable {
  app: AttachedSurface;
  buildInfo(): Promise<AppBuildInfo | null>;
  activation(): Promise<{ activatedAt: string; denBaseUrl: string } | null>;
  rootText(): Promise<string>;
  exceptions(): RendererException[];
  /** Updater activity this launch logged (earlier launches on the same profile are excluded). */
  updaterActivity(): Promise<UpdaterActivity>;
  /** Quit the way Cmd+Q does and wait for the main process to be gone. */
  quit(): Promise<{ exited: boolean }>;
}

async function feedVersion(feedDir: string): Promise<string> {
  const manifest = await readFile(join(feedDir, MANIFEST), "utf8").catch(() => {
    throw new Error(`OPENWORK_EVAL_UPDATE_FEED_DIR has no ${MANIFEST}: ${feedDir}`);
  });
  const version = /^version:\s*['"]?([^'"\s]+)/m.exec(manifest)?.[1];
  if (!version) throw new Error(`${MANIFEST} names no version`);
  return version;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("Loopback server has no port");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Static release feed: the manifest and the zip it names, nothing else. */
async function serveFeed(feedDir: string, requests: ServedRequest[]) {
  const root = normalize(feedDir + sep);
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://feed").pathname);
    const file = normalize(join(root, path));
    const record = (status: number) => requests.push({ method: request.method ?? "GET", path, status });
    if (!file.startsWith(root) || (request.method !== "GET" && request.method !== "HEAD")) {
      record(404);
      response.writeHead(404).end();
      return;
    }
    void stat(file).then((info) => {
      if (!info.isFile()) throw new Error("not a file");
      record(200);
      response.writeHead(200, { "Content-Length": info.size, "Content-Type": file.endsWith(".zip") ? "application/zip" : "text/yaml" });
      if (request.method === "HEAD") response.end();
      else createReadStream(file).pipe(response);
    }).catch(() => {
      record(404);
      response.writeHead(404).end();
    });
  });
  return { server, url: await listen(server) };
}

/** The one Den answer the update path needs: which desktop versions are published. Everything else is not found. */
async function serveDen(latestAppVersion: string, requests: ServedRequest[]) {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://den").pathname;
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors).end();
      return;
    }
    const versions = path === "/v1/app-version" || path === "/api/den/v1/app-version";
    const status = versions ? 200 : 404;
    requests.push({ method: request.method ?? "GET", path, status });
    const body = versions
      ? { minAppVersion: "0.0.0", latestAppVersion, publishedDesktopVersions: [latestAppVersion] }
      : { error: "not_found" };
    response.writeHead(status, { ...cors, "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { server, url: await listen(server) };
}

/** CFBundleShortVersionString of the bundle on disk, which is what Squirrel.Mac replaces. */
export async function bundleVersion(bundle: string): Promise<string> {
  const { stdout } = await execFileAsync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(bundle, "Contents/Info.plist")]);
  return stdout.trim();
}

export async function packagedUpdateInstallWorld(seed: Seed) {
  if (process.platform !== "darwin") throw new SkipError("run on darwin");
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new SkipError("set OPENWORK_EVAL_ELECTRON_BINARY");
  const feedDir = process.env.OPENWORK_EVAL_UPDATE_FEED_DIR?.trim();
  if (!feedDir) throw new SkipError("set OPENWORK_EVAL_UPDATE_FEED_DIR");
  if (!appBundleOf(binary)) throw new Error(`OPENWORK_EVAL_ELECTRON_BINARY is not inside an .app bundle: ${binary}`);

  const updateVersion = await feedVersion(feedDir);
  const feedRequests: ServedRequest[] = [];
  const denRequests: ServedRequest[] = [];
  const feed = await serveFeed(feedDir, feedRequests);
  const den = await serveDen(updateVersion, denRequests).catch(async (error: unknown) => {
    await close(feed.server);
    throw error;
  });

  const owned: string[] = [];
  const launches: UpdateLaunch[] = [];
  const host = localHost();
  const activatedAt = new Date().toISOString();
  const installRoot = seed.tmpPath("packaged-update-install-bundle");
  owned.push(installRoot);
  const installedBinary = await pristineCopy(binary, installRoot);
  const installedBundle = appBundleOf(installedBinary);
  if (!installedBundle) throw new Error(`The installed copy is not an .app bundle: ${installedBinary}`);
  const profileRoot = seed.tmpPath("packaged-update-install-profile");
  owned.push(profileRoot);
  const profileDir = join(profileRoot, "profile");
  const bootstrap: NonNullable<ElectronSurfaceOptions["bootstrap"]> = {
    baseUrl: den.url,
    apiBaseUrl: den.url,
    requireSignin: true,
    enterpriseActivation: { activatedAt, denBaseUrl: den.url },
  };

  async function launch(seedBootstrap: boolean): Promise<UpdateLaunch> {
    const name = `packaged-update-install-${launches.length + 1}`;
    // The host appends every launch on this profile to one log; read only this launch's part.
    const logPath = join(profileDir, "electron.log");
    const logOffset = await stat(logPath).then((info) => info.size, () => 0);
    const handle: SurfaceHandle = await withElectronBinary(installedBinary, () => host.spawnElectron(name, {
      profile: "fresh",
      profileDir,
      prepareSharedResources: false,
      ...(seedBootstrap ? { bootstrap } : {}),
      env: {
        OPENWORK_DEV_MODE: "0",
        OPENWORK_ELECTRON_START_URL: "",
        ELECTRON_START_URL: "",
        OPENWORK_EVAL_UPDATE_FEED_URL: feed.url,
      },
    }));
    const log = handle.meta?.log ?? logPath;
    let app: AttachedSurface | null = null;
    let witness: Awaited<ReturnType<typeof observeRendererExceptions>> | null = null;
    let stopped = false;
    const dispose = async () => {
      if (stopped) return;
      stopped = true;
      witness?.close();
      try {
        await app?.stop();
      } finally {
        await host.disposeSurface(handle);
      }
    };
    try {
      app = await attachSurface(handle, { timeoutMs: 60_000 });
      witness = await observeRendererExceptions(app);
    } catch (error) {
      await dispose().catch(() => undefined);
      throw error;
    }
    const attached = app;
    const observed = witness;
    const launched: UpdateLaunch = {
      app: attached,
      buildInfo: () => readBuildInfo(attached),
      activation: () => readActivation(attached),
      rootText: () => evaluateOnSurface(attached, () => document.getElementById("root")?.innerText ?? ""),
      exceptions: () => [...observed.exceptions],
      updaterActivity: async () => updaterActivityFromLog((await readFile(log)).subarray(logOffset).toString("utf8")),
      async quit() {
        if (stopped) return { exited: true };
        await quitDesktop(attached);
        const exited = handle.pid === undefined ? true : await waitUntilGone(handle.pid, 30_000);
        await dispose();
        return { exited };
      },
      [Symbol.asyncDispose]: dispose,
    };
    launches.push(launched);
    return launched;
  }

  return {
    updateVersion,
    activatedAt,
    denUrl: den.url,
    feedUrl: feed.url,
    installedBundle,
    feedRequests: () => [...feedRequests],
    denRequests: () => [...denRequests],
    bundleVersion: () => bundleVersion(installedBundle),
    /** First launch writes the activated bootstrap; later launches boot what the product persisted. */
    launch,
    /** Squirrel's ShipIt applies the staged bundle after the app exits; wait for it to finish. */
    waitForShipIt: () => waitForShipItIdle(120_000),
    [Symbol.asyncDispose]: async () => {
      for (const launched of launches.reverse()) {
        try {
          await launched[Symbol.asyncDispose]();
        } catch {
          // Best effort: the servers and owned directories below are still released.
        }
      }
      await waitForShipItIdle(60_000);
      await Promise.all([close(feed.server), close(den.server)]);
      for (const path of owned) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
