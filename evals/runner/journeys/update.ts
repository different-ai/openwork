import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EvalError } from "../context.ts";
import {
  ReleaseFeedLab,
  ReleaseLabError,
  compareReleaseVersions,
  isReleaseLabError,
} from "../labs/release-feed.ts";
import type { FlowContext } from "../flow.ts";
import type { ReleaseDistribution, ReleaseLabErrorCode, ReleasePlatform } from "../labs/release-feed.ts";

type StableDesktopUpdateSelection =
  | { kind: "update"; targetVersion: string; latestPublishedVersion: string }
  | { kind: "blocked"; latestPublishedVersion: string }
  | { kind: "current"; latestPublishedVersion: string };

export interface ReleaseClientInput {
  currentVersion: string;
  platform: ReleasePlatform;
  allowedVersions?: string[] | null;
}

export type ExpectedOfferedVersion = string | null | StableDesktopUpdateSelection;

export interface ExpectOfferedVersionOptions {
  feed: ReleaseFeedLab;
  client: ReleaseClientInput;
  expected: ExpectedOfferedVersion;
}

export type ExpectedDownloadUrl = string | {
  url?: string;
  fileName?: string;
  errorCode?: ReleaseLabErrorCode;
  renamedFileName?: string;
};

export interface ExpectDownloadUrlOptions {
  feed: ReleaseFeedLab;
  version: string;
  platform: ReleasePlatform;
  expected: ExpectedDownloadUrl;
  distribution?: ReleaseDistribution;
}

export interface BootstrapPrecedenceBefore {
  serverUrl: string;
  bundleServerUrl: string;
  installedPath?: "canonical" | "legacy";
  installedWrittenAt?: string;
  bundleWrittenAt?: string;
}

export interface BootstrapPrecedenceAfter {
  serverUrl: string;
}

export interface BootstrapPrecedenceOptions {
  before: BootstrapPrecedenceBefore;
  after: BootstrapPrecedenceAfter;
}

export interface BootstrapPrecedenceResult {
  installedPath: "canonical" | "legacy";
  importedBeforeRead: boolean;
  importedAfterRestart: boolean;
  firstBaseUrl: string;
  restartedBaseUrl: string;
  persistedBaseUrl: string;
  canonicalPath: string;
  legacyPath: string;
}

export interface ExpectActionableFeedErrorOptions {
  feed: ReleaseFeedLab;
}

interface ProductDownloadUrlResult {
  fileName: string;
  githubUrl: string;
}

interface FilenameTagResult {
  host: string;
  token: string;
}

interface WorkspaceStore {
  importBundledDesktopBootstrapConfigIfPreferred(): Promise<boolean>;
  getDesktopBootstrapConfig(): Promise<unknown>;
}

interface WorkspaceStoreModule {
  createWorkspaceStore(input: {
    app: { getPath(name: string): string };
    defaultDenBaseUrl: string;
    defaultRequireSignin: boolean;
    forceRequireSignin: boolean;
  }): WorkspaceStore;
}

interface DesktopUpdaterModule {
  targetedStableUpdaterFeed(currentVersion: string, targetVersion: string): string;
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKSPACE_STORE_PATH = path.join(ROOT, "apps", "desktop", "electron", "workspace-store.mjs");
const DESKTOP_UPDATER_PATH = path.join(ROOT, "apps", "desktop", "electron", "updater.mjs");
const PRODUCT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_den",
  DEN_DB_ENCRYPTION_KEY: process.env.DEN_DB_ENCRYPTION_KEY ?? "local-dev-db-encryption-key-please-change-1234567890",
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? "local-dev-secret-not-for-production-use!!",
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL ?? "http://localhost:3005",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function stringifyActual(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: unknown): void {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : ` (actual: ${stringifyActual(actual).slice(0, 500)})`}`);
}

export function releaseLabProductImportPrecondition(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("bun", ["--version"], { encoding: "utf8", timeout: 5_000 }, (error) => {
      if (!error) {
        resolve(null);
        return;
      }
      resolve(
        "Release lab flows drive real product TypeScript modules through bun, but `bun` is not available on PATH. "
        + "Install Bun and add it to PATH (nightly CI uses oven-sh/setup-bun@v2 with bun 1.3.9), then rerun the flow.",
      );
    });
  });
}

function execBunJson(script: string, input: unknown, moduleLabel: string, env: NodeJS.ProcessEnv = PRODUCT_ENV): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "bun",
      ["-e", script, JSON.stringify(input)],
      { cwd: ROOT, env, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const missingBun = error.code === "ENOENT";
          reject(new EvalError(
            missingBun
              ? `Product import through bun failed while importing ${moduleLabel}: bun was not found on PATH. Install Bun and add it to PATH (nightly CI uses oven-sh/setup-bun@v2 with bun 1.3.9). stderr: ${stderr}`
              : `Product import through bun failed while importing ${moduleLabel}. The release lab uses bun so real product TS modules resolve the same way they do in app/package workspaces. stderr: ${stderr}\nerror: ${error.message}`,
          ));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim() || "null"));
        } catch (parseError) {
          reject(new EvalError(`Product import returned non-JSON output: ${parseError instanceof Error ? parseError.message : String(parseError)}\n${stdout}`));
        }
      },
    );
  });
}

function stableSelectionFromUnknown(value: unknown): StableDesktopUpdateSelection | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "update" && typeof value.targetVersion === "string" && typeof value.latestPublishedVersion === "string") {
    return { kind: "update", targetVersion: value.targetVersion, latestPublishedVersion: value.latestPublishedVersion };
  }
  if (value.kind === "blocked" && typeof value.latestPublishedVersion === "string") {
    return { kind: "blocked", latestPublishedVersion: value.latestPublishedVersion };
  }
  if (value.kind === "current" && typeof value.latestPublishedVersion === "string") {
    return { kind: "current", latestPublishedVersion: value.latestPublishedVersion };
  }
  return null;
}

function productDownloadUrlResultFromUnknown(value: unknown): ProductDownloadUrlResult {
  if (isRecord(value) && typeof value.fileName === "string" && typeof value.githubUrl === "string") {
    return { fileName: value.fileName, githubUrl: value.githubUrl };
  }
  throw new EvalError(`Product download URL result had the wrong shape: ${JSON.stringify(value)}`);
}

function filenameTagFromUnknown(value: unknown): FilenameTagResult | null {
  if (value === null) return null;
  if (isRecord(value) && typeof value.host === "string" && typeof value.token === "string") {
    return { host: value.host, token: value.token };
  }
  return null;
}

function expectedSelectionMatches(actual: StableDesktopUpdateSelection | null, expected: ExpectedOfferedVersion): boolean {
  if (typeof expected === "string") return actual?.kind === "update" && compareReleaseVersions(actual.targetVersion, expected) === 0;
  if (expected === null) return actual === null || actual.kind !== "update";
  if (!actual || actual.kind !== expected.kind) return false;
  if (actual.kind === "update" && expected.kind === "update") return compareReleaseVersions(actual.targetVersion, expected.targetVersion) === 0;
  return actual.latestPublishedVersion === expected.latestPublishedVersion;
}

function expectedDownloadObject(expected: ExpectedDownloadUrl): { url?: string; fileName?: string; errorCode?: ReleaseLabErrorCode; renamedFileName?: string } {
  return typeof expected === "string" ? { url: expected } : expected;
}

async function selectStableDesktopUpdateWithProduct(input: {
  currentVersion: string;
  metadata: unknown;
  allowedVersions?: string[] | null;
}): Promise<StableDesktopUpdateSelection | null> {
  const script = `
const input = JSON.parse(process.argv[1]);
const module = await import("./apps/app/src/app/lib/version-gate.ts");
const desktopConfig = Array.isArray(input.allowedVersions) ? { allowedDesktopVersions: input.allowedVersions } : {};
const selection = module.selectStableDesktopUpdate({ currentVersion: input.currentVersion, metadata: input.metadata, desktopConfig });
console.log(JSON.stringify(selection));
`;
  return stableSelectionFromUnknown(await execBunJson(script, input, "apps/app/src/app/lib/version-gate.ts"));
}

async function productDownloadUrl(input: {
  version: string;
  platform: ReleasePlatform;
  distribution: ReleaseDistribution;
}): Promise<ProductDownloadUrlResult> {
  const script = `
const input = JSON.parse(process.argv[1]);
const module = await import("./ee/apps/den-api/src/utils/installer-artifacts.ts");
const releaseTag = input.version.startsWith("v") ? input.version : "v" + input.version;
const fileName = input.distribution === "cloud"
  ? module.cloudDesktopReleaseAssetName(input.platform, releaseTag)
  : input.distribution === "public"
    ? module.desktopReleaseAssetName(input.platform, releaseTag)
    : module.enterpriseDesktopReleaseAssetName(input.platform, releaseTag);
const githubUrl = module.installerReleaseAssetUrl(fileName, { releaseTag, releaseRepo: "different-ai/openwork" });
console.log(JSON.stringify({ fileName, githubUrl }));
`;
  return productDownloadUrlResultFromUnknown(await execBunJson(script, input, "ee/apps/den-api/src/utils/installer-artifacts.ts"));
}

async function parseInstallerFilenameTagWithProduct(fileName: string): Promise<FilenameTagResult | null> {
  const script = `
const input = JSON.parse(process.argv[1]);
const module = await import("./packages/install-config/src/index.ts");
console.log(JSON.stringify(module.parseInstallerFilenameTag(input.fileName)));
`;
  return filenameTagFromUnknown(await execBunJson(script, { fileName }, "packages/install-config/src/index.ts"));
}

function baseUrlFromUnknown(value: unknown): string {
  if (isRecord(value) && typeof value.baseUrl === "string") return value.baseUrl;
  return "";
}

function isWorkspaceStoreModule(value: unknown): value is WorkspaceStoreModule {
  return isRecord(value) && typeof value.createWorkspaceStore === "function";
}

function isDesktopUpdaterModule(value: unknown): value is DesktopUpdaterModule {
  return isRecord(value) && typeof value.targetedStableUpdaterFeed === "function";
}

async function targetedStableUpdaterFeedWithProduct(currentVersion: string, targetVersion: string): Promise<string> {
  const moduleUrl = new URL(`file://${DESKTOP_UPDATER_PATH}?release-lab=${Date.now()}-${Math.random()}`);
  const module = await import(moduleUrl.href);
  if (!isDesktopUpdaterModule(module)) throw new EvalError("updater.mjs did not export targetedStableUpdaterFeed.");
  return module.targetedStableUpdaterFeed(currentVersion, targetVersion);
}

async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readPersistedBaseUrl(canonicalPath: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(canonicalPath, "utf8"));
  return baseUrlFromUnknown(parsed);
}

export async function expectOfferedVersion(ctx: FlowContext, options: ExpectOfferedVersionOptions): Promise<StableDesktopUpdateSelection | null> {
  const metadata = options.feed.metadata();
  const selection = await selectStableDesktopUpdateWithProduct({
    currentVersion: options.client.currentVersion,
    metadata,
    allowedVersions: options.client.allowedVersions,
  });
  witness(
    ctx,
    expectedSelectionMatches(selection, options.expected),
    "apps/app/src/app/lib/version-gate.ts selectStableDesktopUpdate offered the expected version",
    { client: options.client, metadata, selection, expected: options.expected },
  );
  if (selection?.kind === "update") {
    const targetedFeedUrl = await targetedStableUpdaterFeedWithProduct(options.client.currentVersion, selection.targetVersion);
    witness(
      ctx,
      targetedFeedUrl.endsWith(`/v${selection.targetVersion}`) && !targetedFeedUrl.includes("/latest/"),
      "apps/desktop/electron/updater.mjs targetedStableUpdaterFeed built a version-specific stable feed URL",
      { targetedFeedUrl, labFeedUrl: options.feed.localizeGitHubUrl(targetedFeedUrl) },
    );
    ctx.output("product version selection", JSON.stringify({ client: options.client, metadata, selection, targetedFeedUrl }, null, 2));
    return selection;
  }
  ctx.output("product version selection", JSON.stringify({ client: options.client, metadata, selection }, null, 2));
  return selection;
}

export async function expectDownloadUrl(ctx: FlowContext, options: ExpectDownloadUrlOptions): Promise<string | null> {
  const expected = expectedDownloadObject(options.expected);
  const distribution = options.distribution ?? "enterprise";
  try {
    const product = await productDownloadUrl({ version: options.version, platform: options.platform, distribution });
    options.feed.assertInstallableAsset(options.version, options.platform, distribution);
    const localUrl = options.feed.localizeGitHubUrl(product.githubUrl);
    witness(
      ctx,
      expected.url === undefined || localUrl === expected.url,
      "ee/apps/den-api/src/utils/installer-artifacts.ts constructed the expected release asset URL when localized to the lab host",
      { product, localUrl, expected: expected.url },
    );
    if (expected.fileName) {
      witness(ctx, product.fileName === expected.fileName, "Den installer artifact code selected the expected filename", { product, expected: expected.fileName });
    }
    if (expected.renamedFileName) {
      const asset = options.feed.resolveClientDownloadedAsset(options.version, options.platform, expected.renamedFileName);
      const parsedTag = await parseInstallerFilenameTagWithProduct(expected.renamedFileName);
      witness(ctx, asset.fileName === product.fileName, "Release lab resolves a browser-renamed downloaded file back to the original asset", { renamedFileName: expected.renamedFileName, asset: asset.fileName, parsedTag });
    }
    ctx.output("product download URL", JSON.stringify({ ...product, localUrl }, null, 2));
    return localUrl;
  } catch (error) {
    if (isReleaseLabError(error) && expected.errorCode === error.code) {
      witness(ctx, true, `Release lab surfaced actionable ${error.code}`, { message: error.message, action: error.action });
      ctx.output("actionable release error", JSON.stringify({ code: error.code, message: error.message, action: error.action }, null, 2));
      return null;
    }
    throw error;
  }
}

export async function resolveBootstrapPrecedence(options: BootstrapPrecedenceOptions): Promise<BootstrapPrecedenceResult> {
  const root = await mkdtemp(path.join(tmpdir(), "openwork-release-bootstrap-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const userData = path.join(root, "userData");
  const bundleDir = path.join(root, "downloads", "OpenWork update bundle");
  const canonicalPath = path.join(xdg, "openwork", "desktop-bootstrap.json");
  const legacyPath = path.join(home, ".config", "openwork", "desktop-bootstrap.json");
  const installedPath = options.before.installedPath ?? "canonical";
  const installedBootstrapPath = installedPath === "legacy" ? legacyPath : canonicalPath;
  const previousHome = process.env.HOME;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const previousOverride = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  const previousBundle = process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR;
  const previousDevMode = process.env.OPENWORK_DEV_MODE;

  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  process.env.OPENWORK_BOOTSTRAP_BUNDLE_DIR = bundleDir;
  delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  delete process.env.OPENWORK_DEV_MODE;

  try {
    await writeJsonFile(installedBootstrapPath, {
      baseUrl: options.before.serverUrl,
      apiBaseUrl: options.before.serverUrl,
      requireSignin: true,
      writtenAt: options.before.installedWrittenAt ?? "2026-07-09T12:00:00.000Z",
    });
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "openwork-win-x64-0.17.40.exe"), "signed installer", "utf8");
    await writeJsonFile(path.join(bundleDir, "desktop-bootstrap.json"), {
      baseUrl: options.before.bundleServerUrl,
      apiBaseUrl: options.before.bundleServerUrl,
      requireSignin: false,
      writtenAt: options.before.bundleWrittenAt ?? "2026-07-10T12:00:00.000Z",
    });

    const moduleUrl = new URL(`file://${WORKSPACE_STORE_PATH}?release-lab=${Date.now()}-${Math.random()}`);
    const module = await import(moduleUrl.href);
    if (!isWorkspaceStoreModule(module)) throw new EvalError("workspace-store.mjs did not export createWorkspaceStore.");
    const createStore = () => module.createWorkspaceStore({
      app: { getPath: (name) => name === "userData" ? userData : root },
      defaultDenBaseUrl: "https://default.openworklabs.com",
      defaultRequireSignin: false,
      forceRequireSignin: false,
    });
    const store = createStore();
    const importedBeforeRead = await store.importBundledDesktopBootstrapConfigIfPreferred();
    const firstConfig = await store.getDesktopBootstrapConfig();
    const restartedStore = createStore();
    const importedAfterRestart = await restartedStore.importBundledDesktopBootstrapConfigIfPreferred();
    const restartedConfig = await restartedStore.getDesktopBootstrapConfig();
    const persistedBaseUrl = await readPersistedBaseUrl(canonicalPath);

    return {
      installedPath,
      importedBeforeRead,
      importedAfterRestart,
      firstBaseUrl: baseUrlFromUnknown(firstConfig),
      restartedBaseUrl: baseUrlFromUnknown(restartedConfig),
      persistedBaseUrl,
      canonicalPath,
      legacyPath,
    };
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("XDG_CONFIG_HOME", previousXdg);
    restoreEnv("OPENWORK_DESKTOP_BOOTSTRAP_PATH", previousOverride);
    restoreEnv("OPENWORK_BOOTSTRAP_BUNDLE_DIR", previousBundle);
    restoreEnv("OPENWORK_DEV_MODE", previousDevMode);
    await rm(root, { recursive: true, force: true });
  }
}

export async function expectBootstrapPrecedenceSurvives(ctx: FlowContext, options: BootstrapPrecedenceOptions): Promise<BootstrapPrecedenceResult> {
  const result = await resolveBootstrapPrecedence(options);
  witness(ctx, result.firstBaseUrl === options.after.serverUrl, "workspace-store.mjs getDesktopBootstrapConfig keeps the installed server URL", result);
  witness(ctx, result.restartedBaseUrl === options.after.serverUrl, "workspace-store.mjs keeps the server URL after update-like re-resolution", result);
  witness(ctx, result.persistedBaseUrl === options.after.serverUrl, "desktop-bootstrap.json persisted the organization server URL", result);
  ctx.output(`bootstrap precedence (${result.installedPath})`, JSON.stringify(result, null, 2));
  return result;
}

export async function expectActionableFeedError(ctx: FlowContext, options: ExpectActionableFeedErrorOptions): Promise<ReleaseLabError> {
  try {
    await options.feed.runActionableProbe();
  } catch (error) {
    if (isReleaseLabError(error) && error.code !== "release_probe_unexpected_success" && error.action.trim()) {
      witness(ctx, true, `Release feed failure surfaced as actionable ${error.code}`, { code: error.code, message: error.message, action: error.action, status: error.status });
      ctx.output(`actionable ${error.code}`, JSON.stringify({ code: error.code, message: error.message, action: error.action, status: error.status }, null, 2));
      return error;
    }
    throw error;
  }
  throw new EvalError("Expected the release feed probe to fail with an actionable error, but it succeeded.");
}
