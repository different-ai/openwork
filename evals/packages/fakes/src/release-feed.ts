import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { trimTrailingSlashes } from "./strings.ts";

export type ReleasePlatform = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-arm64";
export type ReleaseDistribution = "public" | "enterprise" | "cloud";

export type ReleaseLabErrorCode =
  | "release_asset_missing"
  | "release_asset_not_installer_capable"
  | "release_asset_propagation_lag"
  | "release_asset_unavailable"
  | "release_feed_cache_stale"
  | "release_host_denied"
  | "release_probe_unexpected_success";

export type ReleaseAssetFault =
  | { kind: "status"; status: number; message?: string }
  | { kind: "slow-chunked"; chunkSize: number; delayMs: number };

export interface ReleaseAssetInput {
  platform: ReleasePlatform;
  distribution?: ReleaseDistribution;
  fileName?: string;
  body?: string | Uint8Array;
  contentType?: string;
  installerCapable?: boolean;
  rewrittenFileName?: string;
  fault?: ReleaseAssetFault;
}

export interface ReleaseVersionInput {
  version: string;
  publishedAt?: string;
  prerelease?: boolean;
  installerCapable?: boolean;
  assets?: ReleaseAssetInput[];
}

export interface ReleaseAsset {
  platform: ReleasePlatform;
  distribution: ReleaseDistribution;
  fileName: string;
  body: Uint8Array;
  size: number;
  contentType: string;
  installerCapable: boolean;
  rewrittenFileName: string | null;
  fault: ReleaseAssetFault | null;
}

export interface ReleaseVersion {
  version: string;
  tagName: string;
  publishedAt: string;
  prerelease: boolean;
  installerCapable: boolean;
  assets: ReleaseAsset[];
}

export interface DenAppVersionMetadataFixture {
  minAppVersion: string;
  latestAppVersion: string;
  publishedDesktopVersions: string[];
}

export interface CatalogOptions {
  platforms?: ReleasePlatform[];
  distribution?: ReleaseDistribution;
  preInstallerVersions?: string[];
}

export interface ResolveAllowedUpdateInput {
  catalog: ReleaseVersion[];
  currentVersion: string;
  allowedVersions?: string[] | null;
}

export type ReleaseFeedProbe =
  | { kind: "asset"; version: string; platform: ReleasePlatform; allowedHosts?: string[] }
  | { kind: "cache"; expectedVersion: string }
  | { kind: "host"; url?: string; version?: string; platform?: ReleasePlatform; allowedHosts: string[] };

export interface ReleaseFeedLabConfig {
  catalog: ReleaseVersionInput[];
  initialCatalog?: ReleaseVersionInput[];
  allowedVersions?: string[] | null;
  cacheTtlMs?: number;
  staleUntil?: number | Date;
  repo?: string;
  actionableProbe?: ReleaseFeedProbe;
}

export interface ReleaseSnapshot {
  catalog: ReleaseVersion[];
  metadata: DenAppVersionMetadataFixture;
  stale: boolean;
  cachedUntil: number | null;
}

export interface ReleaseAssetUrlInput {
  baseUrl: string;
  version: string;
  fileName: string;
  repo?: string;
}

type ComparableVersion = {
  release: number[];
  prerelease: string[];
};

const DEFAULT_REPO = "different-ai/openwork";
const DEFAULT_PLATFORMS: ReleasePlatform[] = ["mac-arm64", "mac-x64", "win-x64", "linux-x64", "linux-arm64"];
const DEFAULT_DISTRIBUTION: ReleaseDistribution = "enterprise";
const textEncoder = new TextEncoder();

export class ReleaseLabError extends Error {
  code: ReleaseLabErrorCode;
  action: string;
  status: number | null;

  constructor(code: ReleaseLabErrorCode, message: string, action: string, status: number | null = null) {
    super(message);
    this.name = code;
    this.code = code;
    this.action = action;
    this.status = status;
  }
}

export function isReleaseLabError(value: unknown): value is ReleaseLabError {
  return value instanceof ReleaseLabError;
}

function parseComparableVersion(value: string): ComparableVersion | null {
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [withoutBuild] = normalized.split("+", 1);
  if (!withoutBuild) return null;

  const [releasePart, prereleasePart = ""] = withoutBuild.split("-", 2);
  const release = releasePart.split(".").map((part) => Number(part));
  if (release.length !== 3 || release.some((part) => !Number.isInteger(part) || part < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .flatMap((part) => {
      const trimmed = part.trim();
      return trimmed ? [trimmed] : [];
    });
  return { release, prerelease };
}

function comparePrerelease(left: string[], right: string[]): number {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }
    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }
  return 0;
}

export function normalizeReleaseVersion(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
}

export function compareReleaseVersions(left: string, right: string): number | null {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  for (let index = 0; index < 3; index += 1) {
    const leftPart = parsedLeft.release[index];
    const rightPart = parsedRight.release[index];
    if (leftPart === undefined || rightPart === undefined) return null;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}

function requireVersion(value: string): string {
  const normalized = normalizeReleaseVersion(value);
  if (!normalized) {
    throw new ReleaseLabError(
      "release_asset_missing",
      `Release version ${JSON.stringify(value)} is not a stable x.y.z version.`,
      "Use a stable desktop version tag like 0.17.40 or v0.17.40.",
    );
  }
  return normalized;
}

function versionTag(value: string): string {
  return `v${requireVersion(value)}`;
}

function platformFilePart(platform: ReleasePlatform): string {
  if (platform === "linux-x64") return "linux-x86_64";
  return platform;
}

export function desktopReleaseAssetFileName(
  version: string,
  platform: ReleasePlatform,
  distribution: ReleaseDistribution = DEFAULT_DISTRIBUTION,
): string {
  const normalized = requireVersion(version);
  const prefix = distribution === "public" ? "openwork" : `openwork-${distribution}`;
  if (platform === "win-x64") return `${prefix}-win-x64-${normalized}.exe`;
  if (platform === "mac-arm64" || platform === "mac-x64") return `${prefix}-${platform}-${normalized}.dmg`;
  return `${prefix}-${platformFilePart(platform)}-${normalized}.AppImage`;
}

function contentTypeForPlatform(platform: ReleasePlatform): string {
  if (platform.startsWith("mac-")) return "application/x-apple-diskimage";
  if (platform === "win-x64") return "application/vnd.microsoft.portable-executable";
  return "application/vnd.appimage";
}

function assetBody(input: ReleaseAssetInput, version: string): Uint8Array {
  if (typeof input.body === "string") return textEncoder.encode(input.body);
  if (input.body) return input.body;
  return textEncoder.encode(`openwork release ${version} ${input.platform}\n`);
}

function normalizeAsset(input: ReleaseAssetInput, version: string, installerCapable: boolean): ReleaseAsset {
  const distribution = input.distribution ?? DEFAULT_DISTRIBUTION;
  const fileName = input.fileName ?? desktopReleaseAssetFileName(version, input.platform, distribution);
  const body = assetBody(input, version);
  return {
    platform: input.platform,
    distribution,
    fileName,
    body,
    size: body.byteLength,
    contentType: input.contentType ?? contentTypeForPlatform(input.platform),
    installerCapable: input.installerCapable ?? installerCapable,
    rewrittenFileName: input.rewrittenFileName ?? null,
    fault: input.fault ?? null,
  };
}

export function normalizeReleaseCatalog(input: ReleaseVersionInput[]): ReleaseVersion[] {
  const catalog = input.map((entry, index) => {
    const version = requireVersion(entry.version);
    const installerCapable = entry.installerCapable ?? true;
    const assetsInput = entry.assets ?? DEFAULT_PLATFORMS.map((platform) => ({ platform }));
    return {
      version,
      tagName: versionTag(version),
      publishedAt: entry.publishedAt ?? new Date(Date.UTC(2026, 0, 1, 12, 0, index)).toISOString(),
      prerelease: entry.prerelease ?? false,
      installerCapable,
      assets: assetsInput.map((asset) => normalizeAsset(asset, version, installerCapable)),
    };
  });
  return sortReleaseCatalog(catalog);
}

export function createReleaseCatalog(versions: string[], options: CatalogOptions = {}): ReleaseVersionInput[] {
  const preInstallerVersions = options.preInstallerVersions ?? [];
  const platforms = options.platforms ?? DEFAULT_PLATFORMS;
  const distribution = options.distribution ?? DEFAULT_DISTRIBUTION;
  return versions.map((version) => {
    const normalized = requireVersion(version);
    const installerCapable = !preInstallerVersions.some((entry) => compareReleaseVersions(entry, normalized) === 0);
    return {
      version: normalized,
      installerCapable,
      assets: platforms.map((platform) => ({ platform, distribution, installerCapable })),
    };
  });
}

export function sortReleaseCatalog(catalog: ReleaseVersion[]): ReleaseVersion[] {
  return [...catalog].sort((left, right) => compareReleaseVersions(left.version, right.version) ?? 0);
}

export function releaseCatalogMetadata(catalog: ReleaseVersion[]): DenAppVersionMetadataFixture {
  const sorted = sortReleaseCatalog(catalog);
  const versions = sorted.map((entry) => entry.version);
  const minAppVersion = versions[0] ?? "0.0.0";
  const latestAppVersion = versions.at(-1) ?? "0.0.0";
  return { minAppVersion, latestAppVersion, publishedDesktopVersions: versions };
}

export function allowedReleaseCatalog(catalog: ReleaseVersion[], allowedVersions?: string[] | null): ReleaseVersion[] {
  const sorted = sortReleaseCatalog(catalog);
  if (!allowedVersions || allowedVersions.length === 0) return sorted;
  return sorted.filter((release) => allowedVersions.some((allowed) => compareReleaseVersions(release.version, allowed) === 0));
}

export function highestAllowedVersion(catalog: ReleaseVersion[], allowedVersions?: string[] | null): string | null {
  return allowedReleaseCatalog(catalog, allowedVersions).at(-1)?.version ?? null;
}

export function resolveAllowedUpdate(input: ResolveAllowedUpdateInput): string | null {
  const currentVersion = requireVersion(input.currentVersion);
  return allowedReleaseCatalog(input.catalog, input.allowedVersions)
    .filter((release) => compareReleaseVersions(release.version, currentVersion) === 1)
    .at(-1)?.version ?? null;
}

function cleanBaseUrl(value: string): string {
  return trimTrailingSlashes(value.trim());
}

export function buildReleaseAssetUrl(input: ReleaseAssetUrlInput): string {
  const repo = input.repo ?? DEFAULT_REPO;
  return `${cleanBaseUrl(input.baseUrl)}/${repo}/releases/download/${versionTag(input.version)}/${encodeURIComponent(input.fileName)}`;
}

export function simulateBrowserRenamedFileName(fileName: string, suffix = " (1)"): string {
  const extensionIndex = fileName.lastIndexOf(".");
  if (extensionIndex <= 0) return `${fileName}${suffix}`;
  return `${fileName.slice(0, extensionIndex)}${suffix}${fileName.slice(extensionIndex)}`;
}

function stripBrowserRenameSuffix(fileName: string): string {
  return fileName.replace(/ \(\d+\)(?=\.[^.]+$)/, "");
}

export function clientFileNameMatchesAsset(asset: ReleaseAsset, clientFileName: string): boolean {
  const normalized = clientFileName.trim();
  return normalized === asset.fileName
    || normalized === asset.rewrittenFileName
    || stripBrowserRenameSuffix(normalized) === asset.fileName;
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

export function assertReleaseHostAllowed(url: string, allowedHosts: string[]): void {
  const host = hostFromUrl(url);
  if (allowedHosts.includes(host)) return;
  throw new ReleaseLabError(
    "release_host_denied",
    `Release download host ${host || "<invalid>"} is not in the allowed outbound host list.`,
    "Add the release host to enterprise outbound allow rules or configure an internal artifact mirror.",
  );
}

export async function fetchAssetOrThrow(url: string, allowedHosts?: string[]): Promise<Uint8Array> {
  if (allowedHosts) assertReleaseHostAllowed(url, allowedHosts);
  const response = await fetch(url);
  if (!response.ok) throw actionableHttpError(response.status, url);
  return new Uint8Array(await response.arrayBuffer());
}

function actionableHttpError(status: number, url: string): ReleaseLabError {
  if (status === 504) {
    return new ReleaseLabError(
      "release_asset_propagation_lag",
      `Release asset ${url} returned HTTP 504 while the release was still propagating.`,
      "Retry against the mirrored artifact host or wait for release propagation before offering the update.",
      status,
    );
  }
  return new ReleaseLabError(
    "release_asset_unavailable",
    `Release asset ${url} returned HTTP ${status}.`,
    "Surface the failed artifact URL and status to the user instead of silently reporting no update.",
    status,
  );
}

function cacheStaleError(expectedVersion: string): ReleaseLabError {
  return new ReleaseLabError(
    "release_feed_cache_stale",
    `The release feed cache has not exposed ${versionTag(expectedVersion)} yet.`,
    "Bypass or expire the release metadata cache before forcing an update during an enterprise rollout.",
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendText(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (typeof address === "object" && address !== null && typeof address.port === "number") {
    return `http://127.0.0.1:${address.port}`;
  }
  throw new ReleaseLabError(
    "release_asset_unavailable",
    "Release lab server did not expose a TCP port.",
    "Restart the hermetic release lab fixture before running update assertions.",
  );
}

function decodePathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function repoFromSegments(segments: string[]): string | null {
  const releaseIndex = segments.indexOf("releases");
  if (releaseIndex >= 2) return `${segments[releaseIndex - 2]}/${segments[releaseIndex - 1]}`;
  return null;
}

function fileNameFromSegments(segments: string[]): string | null {
  const downloadIndex = segments.indexOf("download");
  if (downloadIndex < 0) return null;
  const fileName = segments.slice(downloadIndex + 2).join("/");
  return fileName || null;
}

function tagFromSegments(segments: string[]): string | null {
  const downloadIndex = segments.indexOf("download");
  if (downloadIndex < 0) return null;
  const tag = segments[downloadIndex + 1];
  return tag || null;
}

function latestDownloadFileNameFromSegments(segments: string[]): string | null {
  const releasesIndex = segments.indexOf("releases");
  if (releasesIndex < 0) return null;
  if (segments[releasesIndex + 1] !== "latest" || segments[releasesIndex + 2] !== "download") return null;
  const fileName = segments.slice(releasesIndex + 3).join("/");
  return fileName || null;
}

function isGitHubReleasesApi(segments: string[]): boolean {
  if (segments.length === 4 && segments[0] === "repos" && segments[3] === "releases") return true;
  return segments.length === 5 && segments[0] === "api" && segments[1] === "repos" && segments[4] === "releases";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ReleaseFeedLab {
  private catalog: ReleaseVersion[];
  private initialCatalog: ReleaseVersion[];
  private cachedSnapshot: ReleaseSnapshot | null;
  private server: Server | null;
  private baseUrlValue: string | null;
  private readonly allowedVersions: string[] | null;
  private readonly cacheTtlMs: number;
  private readonly staleUntilMs: number | null;
  private readonly repo: string;
  private readonly actionableProbe: ReleaseFeedProbe | null;

  constructor(config: ReleaseFeedLabConfig) {
    this.catalog = normalizeReleaseCatalog(config.catalog);
    this.initialCatalog = normalizeReleaseCatalog(config.initialCatalog ?? config.catalog);
    this.cachedSnapshot = null;
    this.server = null;
    this.baseUrlValue = null;
    this.allowedVersions = config.allowedVersions ? [...config.allowedVersions] : null;
    this.cacheTtlMs = Math.max(0, config.cacheTtlMs ?? 0);
    this.staleUntilMs = config.staleUntil instanceof Date ? config.staleUntil.getTime() : config.staleUntil ?? null;
    this.repo = config.repo ?? DEFAULT_REPO;
    this.actionableProbe = config.actionableProbe ?? null;
  }

  get baseUrl(): string {
    if (!this.baseUrlValue) {
      throw new ReleaseLabError(
        "release_asset_unavailable",
        "Release lab server has not been started.",
        "Call feed.start() before constructing hermetic artifact URLs.",
      );
    }
    return this.baseUrlValue;
  }

  updateCatalog(catalog: ReleaseVersionInput[]): void {
    this.catalog = normalizeReleaseCatalog(catalog);
  }

  clearCache(): void {
    this.cachedSnapshot = null;
  }

  snapshot(now = Date.now()): ReleaseSnapshot {
    const staleByKnob = this.staleUntilMs !== null && now < this.staleUntilMs;
    if (staleByKnob) return this.makeSnapshot(this.initialCatalog, true, this.staleUntilMs);

    if (this.cachedSnapshot && this.cachedSnapshot.cachedUntil !== null && now < this.cachedSnapshot.cachedUntil) {
      return this.cachedSnapshot;
    }

    const cachedUntil = this.cacheTtlMs > 0 ? now + this.cacheTtlMs : null;
    const snapshot = this.makeSnapshot(this.catalog, false, cachedUntil);
    if (cachedUntil !== null) this.cachedSnapshot = snapshot;
    return snapshot;
  }

  metadata(now = Date.now()): DenAppVersionMetadataFixture {
    return this.snapshot(now).metadata;
  }

  highestAllowedVersion(now = Date.now()): string | null {
    return highestAllowedVersion(this.snapshot(now).catalog, this.allowedVersions);
  }

  resolveAllowedUpdate(currentVersion: string, now = Date.now()): string | null {
    return resolveAllowedUpdate({ catalog: this.snapshot(now).catalog, currentVersion, allowedVersions: this.allowedVersions });
  }

  assetUrl(version: string, platform: ReleasePlatform, distribution: ReleaseDistribution = DEFAULT_DISTRIBUTION): string {
    const asset = this.resolveAsset(version, platform, distribution);
    return buildReleaseAssetUrl({ baseUrl: this.baseUrl, repo: this.repo, version, fileName: asset.fileName });
  }

  githubAssetUrl(version: string, platform: ReleasePlatform, distribution: ReleaseDistribution = DEFAULT_DISTRIBUTION): string {
    const asset = this.resolveAsset(version, platform, distribution);
    return buildReleaseAssetUrl({ baseUrl: "https://github.com", repo: this.repo, version, fileName: asset.fileName });
  }

  localizeGitHubUrl(url: string): string {
    const parsed = new URL(url);
    return `${this.baseUrl}${parsed.pathname}`;
  }

  resolveAsset(version: string, platform: ReleasePlatform, distribution: ReleaseDistribution = DEFAULT_DISTRIBUTION): ReleaseAsset {
    const normalized = requireVersion(version);
    const release = this.snapshot().catalog.find((entry) => compareReleaseVersions(entry.version, normalized) === 0);
    if (!release) {
      throw new ReleaseLabError(
        "release_asset_missing",
        `Release ${versionTag(normalized)} is not present in the hermetic catalog.`,
        "Publish the requested version in the release feed before allowing clients to target it.",
      );
    }
    const asset = release.assets.find((entry) => entry.platform === platform && entry.distribution === distribution)
      ?? release.assets.find((entry) => entry.platform === platform);
    if (!asset) {
      throw new ReleaseLabError(
        "release_asset_missing",
        `Release ${versionTag(normalized)} has no ${platform} artifact.`,
        "Keep the update hidden for this platform until the matching installer asset exists.",
      );
    }
    return asset;
  }

  assertInstallableAsset(version: string, platform: ReleasePlatform, distribution: ReleaseDistribution = DEFAULT_DISTRIBUTION): ReleaseAsset {
    const asset = this.resolveAsset(version, platform, distribution);
    if (asset.installerCapable) return asset;
    throw new ReleaseLabError(
      "release_asset_not_installer_capable",
      `Release ${versionTag(version)} has ${platform} assets that predate installer-capable desktop releases.`,
      "Approve a newer desktop version with signed installer assets, or mount a compatible artifact before exposing the install path.",
    );
  }

  resolveClientDownloadedAsset(version: string, platform: ReleasePlatform, clientFileName: string): ReleaseAsset {
    const release = this.snapshot().catalog.find((entry) => compareReleaseVersions(entry.version, version) === 0);
    const asset = release?.assets.find((entry) => entry.platform === platform && clientFileNameMatchesAsset(entry, clientFileName));
    if (!asset) {
      throw new ReleaseLabError(
        "release_asset_missing",
        `Downloaded filename ${JSON.stringify(clientFileName)} did not resolve to a ${platform} release asset.`,
        "Resolve install metadata from the URL or bundle manifest, not solely from a browser-controlled filename.",
      );
    }
    return asset;
  }

  async start(): Promise<this> {
    if (this.server) return this;
    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    this.server = server;
    this.baseUrlValue = serverBaseUrl(server);
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    this.server = null;
    this.baseUrlValue = null;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }

  async runActionableProbe(): Promise<never> {
    const probe = this.actionableProbe;
    if (!probe) {
      throw new ReleaseLabError(
        "release_probe_unexpected_success",
        "No degraded release-feed probe was configured.",
        "Configure the lab with a 504 asset, stale cache, or denied-host probe before asserting actionable errors.",
      );
    }

    if (probe.kind === "cache") {
      const metadata = this.metadata();
      if (!metadata.publishedDesktopVersions.some((version) => compareReleaseVersions(version, probe.expectedVersion) === 0)) {
        throw cacheStaleError(probe.expectedVersion);
      }
      throw new ReleaseLabError(
        "release_probe_unexpected_success",
        `Expected ${versionTag(probe.expectedVersion)} to be hidden by cache lag, but it was visible.`,
        "Tighten the cache-lag fixture before asserting stale-feed behavior.",
      );
    }

    if (probe.kind === "host") {
      const url = probe.url
        ?? this.githubAssetUrl(probe.version ?? this.metadata().latestAppVersion, probe.platform ?? "win-x64");
      assertReleaseHostAllowed(url, probe.allowedHosts);
      throw new ReleaseLabError(
        "release_probe_unexpected_success",
        `Expected ${url} to be denied by host policy, but it was allowed.`,
        "Use an allowed-host list that excludes the release host for this degraded-flow frame.",
      );
    }

    const url = this.assetUrl(probe.version, probe.platform);
    await fetchAssetOrThrow(url, probe.allowedHosts);
    throw new ReleaseLabError(
      "release_probe_unexpected_success",
      `Expected ${url} to fail, but it downloaded successfully.`,
      "Attach a fault knob to the release asset before asserting propagation failures.",
    );
  }

  private makeSnapshot(catalog: ReleaseVersion[], stale: boolean, cachedUntil: number | null): ReleaseSnapshot {
    const allowedCatalog = allowedReleaseCatalog(catalog, this.allowedVersions);
    return {
      catalog: allowedCatalog,
      metadata: releaseCatalogMetadata(allowedCatalog.length > 0 ? allowedCatalog : catalog),
      stale,
      cachedUntil,
    };
  }

  private githubReleasesJson(): unknown[] {
    return this.snapshot().catalog.slice().reverse().map((release) => ({
      url: `${this.baseUrl}/repos/${this.repo}/releases/tags/${release.tagName}`,
      html_url: `${this.baseUrl}/${this.repo}/releases/tag/${release.tagName}`,
      tag_name: release.tagName,
      name: release.tagName,
      draft: false,
      prerelease: release.prerelease,
      published_at: release.publishedAt,
      assets: release.assets.map((asset, index) => ({
        id: `${release.version}-${index}`,
        name: asset.fileName,
        label: asset.fileName,
        state: "uploaded",
        size: asset.size,
        content_type: asset.contentType,
        browser_download_url: buildReleaseAssetUrl({ baseUrl: this.baseUrl, repo: this.repo, version: release.version, fileName: asset.fileName }),
      })),
    }));
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const segments = decodePathSegments(requestUrl);

      if (requestUrl.pathname === "/v1/app-version") {
        sendJson(res, 200, this.metadata());
        return;
      }

      if (isGitHubReleasesApi(segments)) {
        sendJson(res, 200, this.githubReleasesJson());
        return;
      }

      if (requestUrl.pathname.endsWith(".yml")) {
        this.sendElectronUpdaterManifest(res, segments);
        return;
      }

      const latestFileName = latestDownloadFileNameFromSegments(segments);
      if (latestFileName) {
        const latestVersion = this.metadata().latestAppVersion;
        await this.sendAsset(res, latestVersion, latestFileName);
        return;
      }

      const tag = tagFromSegments(segments);
      const fileName = fileNameFromSegments(segments);
      if (tag && fileName) {
        await this.sendAsset(res, tag, fileName);
        return;
      }

      sendJson(res, 404, { error: "not_found", path: requestUrl.pathname, repo: repoFromSegments(segments) });
    } catch (error) {
      const body = isReleaseLabError(error)
        ? { error: error.code, message: error.message, action: error.action }
        : { error: "release_lab_internal_error", message: error instanceof Error ? error.message : String(error) };
      sendJson(res, 500, body);
    }
  }

  private sendElectronUpdaterManifest(res: ServerResponse, segments: string[]): void {
    const tag = tagFromSegments(segments) ?? this.metadata().latestAppVersion;
    const version = requireVersion(tag);
    const asset = this.resolveAsset(version, "mac-arm64", "enterprise");
    const url = buildReleaseAssetUrl({ baseUrl: this.baseUrl, repo: this.repo, version, fileName: asset.fileName });
    sendText(res, 200, `version: ${version}\nfiles:\n  - url: ${asset.fileName}\n    sha512: release-lab-fixture\n    size: ${asset.size}\npath: ${asset.fileName}\nsha512: release-lab-fixture\nreleaseDate: ${this.snapshot().catalog.find((entry) => entry.version === version)?.publishedAt ?? new Date(0).toISOString()}\n`, {
      "x-release-lab-asset-url": url,
    });
  }

  private async sendAsset(res: ServerResponse, version: string, fileName: string): Promise<void> {
    const normalizedVersion = requireVersion(version);
    const release = this.snapshot().catalog.find((entry) => compareReleaseVersions(entry.version, normalizedVersion) === 0);
    const asset = release?.assets.find((entry) => entry.fileName === fileName);
    if (!asset) {
      sendJson(res, 404, { error: "release_asset_missing", version: normalizedVersion, fileName });
      return;
    }

    if (asset.fault?.kind === "status") {
      sendJson(res, asset.fault.status, { error: "release_asset_fault", message: asset.fault.message ?? `HTTP ${asset.fault.status}` });
      return;
    }

    const headers = {
      "content-type": asset.contentType,
      "content-length": String(asset.size),
      "connection": "close",
      "content-disposition": `attachment; filename="${(asset.rewrittenFileName ?? asset.fileName).replace(/["\\]/g, "-")}"`,
      "cache-control": "private, max-age=300",
      "x-release-lab-version": normalizedVersion,
      "x-release-lab-installer-capable": String(asset.installerCapable),
    };
    res.writeHead(200, headers);

    if (asset.fault?.kind === "slow-chunked") {
      for (let index = 0; index < asset.body.byteLength; index += asset.fault.chunkSize) {
        res.write(asset.body.slice(index, index + asset.fault.chunkSize));
        await sleep(asset.fault.delayMs);
      }
      res.end();
      return;
    }

    res.end(asset.body);
  }
}

export function denMetadataFromUnknown(value: unknown): DenAppVersionMetadataFixture | null {
  if (!isRecord(value)) return null;
  const minAppVersion = typeof value.minAppVersion === "string" ? value.minAppVersion : "";
  const latestAppVersion = typeof value.latestAppVersion === "string" ? value.latestAppVersion : "";
  const publishedDesktopVersions = Array.isArray(value.publishedDesktopVersions)
    ? value.publishedDesktopVersions.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (!minAppVersion || !latestAppVersion) return null;
  return { minAppVersion, latestAppVersion, publishedDesktopVersions };
}
