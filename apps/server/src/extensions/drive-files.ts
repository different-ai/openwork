import { createHash, randomBytes } from "node:crypto";
import { constants, realpathSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { GOOGLE_DRIVE_PULL_CHUNK_BYTES, GOOGLE_DRIVE_PULL_MAX_BYTES, GOOGLE_DRIVE_UPLOAD_MAX_BYTES } from "@openwork/types/google-drive-upload";
import { MICROSOFT_DRIVE_PULL_CHUNK_BYTES, MICROSOFT_DRIVE_TRANSFER_MAX_BYTES, MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES } from "@openwork/types/microsoft-drive-transfer";

import { ApiError } from "../errors.js";
import { runtimeStorageDir } from "../runtime-db.js";
import { externalFetch } from "../server-fetch.js";
import type { DriveFileApprovalRequest, ServerConfig } from "../types.js";
import {
  allowedRoots,
  cloudUploadEndpoint,
  isWithinRoot,
  mimeTypeForPath,
  resolveAuthorizedFile,
  searchRoots,
  type CloudUploadDependencies,
} from "./cloud-uploads.js";
import { uploadDriveResumableFile } from "./drive-resumable-upload.js";
import { openWorkspaceFileForWriting, proveHandleInPlace, WorkspaceFileError } from "../workspace-file-identity.js";

const LINKS_FILE = "drive-links.json";
const DEN_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_STATUS_FILES = 50;
const CONNECTION_ID = /^(google-workspace|emc_[A-Za-z0-9]+)$/;
const MICROSOFT_CONNECTION_ID = /^(microsoft-365|emc_[A-Za-z0-9]+)$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,512}$/;
// Graph item and drive ids, such as b!x2_Kr or 01ABCDEF, are opaque but never hold whitespace or path characters.
const MICROSOFT_ID = /^[^\s/\\?#]{1,512}$/;
const MICROSOFT_LINK_HOST = /(^|\.)(sharepoint\.(com|us|cn|de)|sharepoint-mil\.us|onedrive\.(com|live\.com)|1drv\.ms)$/;

type Provider = "google-workspace" | "microsoft-365";
/** A Google Drive file id, or a Microsoft item (with its drive) or file link. */
type FileTarget = { fileId: string } | { itemId: string; driveId?: string } | { url: string };
const SERVICE_NAME: Record<Provider, string> = { "google-workspace": "Drive", "microsoft-365": "OneDrive or SharePoint" };
// Exported formats Drive can import back into the same Google file type when saved as a copy.
const CONVERTIBLE_FORMATS: Record<string, string[]> = {
  "application/vnd.google-apps.spreadsheet": ["xlsx", "csv"],
  "application/vnd.google-apps.document": ["docx", "md", "txt"],
  "application/vnd.google-apps.presentation": ["pptx"],
};

/** Only the embedding Desktop host can supply this callback; request payloads and shell credentials cannot approve a write. */
async function confirmDriveTransfer(config: ServerConfig, request: DriveFileApprovalRequest, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!config.driveFileApproval) {
    throw new ApiError(403, "drive_approval_unavailable", "OpenWork Desktop must confirm this Drive transfer. Open the desktop app and try again.");
  }
  const approved = await config.driveFileApproval(request);
  signal?.throwIfAborted();
  if (!approved) throw new ApiError(403, "drive_write_denied", "The Drive transfer was not approved. Nothing was changed.");
}

type DriveLink = {
  /** Absent on records made before Microsoft 365 files: those are Google Drive. */
  provider?: Provider;
  fileId: string;
  /** Microsoft only: the drive holding fileId. */
  driveId?: string;
  connectionId: string | null;
  name: string;
  driveMimeType: string;
  native: boolean;
  format: string | null;
  localMimeType: string;
  revision: string | null;
  md5Checksum: string | null;
  sha256: string;
  size: number;
  parents: string[];
  webViewLink: string | null;
  pulledAt: string;
  pushedAt?: string;
};

type DriveLinks = { version: 1; links: Record<string, DriveLink> };

type DownloadInfo = {
  file: { id: string; driveId: string; name: string; mimeType: string; native: boolean; revision: string | null; md5Checksum: string | null; size: number | null; webViewLink: string | null; parents: string[] };
  download: { format: string | null; mimeType: string; extension: string | null; size: number | null; exported: boolean; maxBytes: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readArgString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function optionalConnectionId(args: Record<string, unknown>, provider: Provider = "google-workspace") {
  if (args.connectionId === undefined) return undefined;
  const pattern = provider === "microsoft-365" ? MICROSOFT_CONNECTION_ID : CONNECTION_ID;
  if (typeof args.connectionId !== "string" || !pattern.test(args.connectionId)) {
    throw new ApiError(400, "invalid_payload", provider === "microsoft-365"
      ? "connectionId must identify a Microsoft 365 connection."
      : "connectionId must identify a native Google Workspace connection.");
  }
  return args.connectionId;
}

function isMicrosoftLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && MICROSOFT_LINK_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** An explicit provider wins; otherwise a driveId, a Microsoft connection or a OneDrive/SharePoint link means Microsoft 365. */
function providerFor(args: Record<string, unknown>): Provider {
  if (args.provider !== undefined) {
    if (args.provider !== "google-workspace" && args.provider !== "microsoft-365") throw new ApiError(400, "invalid_payload", "provider must be google-workspace or microsoft-365.");
    return args.provider;
  }
  if (args.driveId !== undefined || args.connectionId === "microsoft-365") return "microsoft-365";
  return isMicrosoftLink(readArgString(args, "fileId")) ? "microsoft-365" : "google-workspace";
}

function microsoftTarget(args: Record<string, unknown>): FileTarget {
  const fileId = readArgString(args, "fileId");
  const driveId = args.driveId === undefined ? undefined : readArgString(args, "driveId");
  if (driveId !== undefined && !MICROSOFT_ID.test(driveId)) throw new ApiError(400, "invalid_payload", "driveId must be a Microsoft drive id.");
  if (isMicrosoftLink(fileId)) {
    if (driveId !== undefined) throw new ApiError(400, "invalid_payload", "Pass a OneDrive or SharePoint link, or an item id with its driveId, not both.");
    return { url: fileId };
  }
  if (!MICROSOFT_ID.test(fileId)) throw new ApiError(400, "invalid_payload", "fileId must be a OneDrive or SharePoint item id or file link.");
  return { itemId: fileId, ...(driveId ? { driveId } : {}) };
}

/** Accepts a bare ID or a Drive, Docs, Sheets or Slides link. */
export function parseDriveFileId(value: string) {
  const trimmed = value.trim();
  if (DRIVE_ID.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const fromPath = /\/d\/([A-Za-z0-9_-]{1,512})(?:\/|$)/.exec(url.pathname)?.[1];
    const fromQuery = url.searchParams.get("id");
    const id = fromPath ?? fromQuery ?? "";
    if (DRIVE_ID.test(id)) return id;
  } catch {
    // Not a link.
  }
  throw new ApiError(400, "invalid_payload", "fileId must be a Google Drive file ID or a Drive, Docs, Sheets or Slides link.");
}

// One writer at a time: pulls and pushes update the link record.
let linkQueue: Promise<unknown> = Promise.resolve();
function withLinks<T>(config: ServerConfig, update: (links: DriveLinks) => Promise<T> | T): Promise<T> {
  const run = linkQueue.then(async () => {
    const links = await readLinks(config);
    const result = await update(links);
    const path = join(runtimeStorageDir(config), LINKS_FILE);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(links), { mode: 0o600 });
    await rename(temporary, path);
    return result;
  });
  linkQueue = run.catch(() => undefined);
  return run;
}

/** Host-owned, so file content cannot redirect a push to another Drive file. */
async function readLinks(config: ServerConfig): Promise<DriveLinks> {
  try {
    const value: unknown = JSON.parse(await readFile(join(runtimeStorageDir(config), LINKS_FILE), "utf8"));
    if (isRecord(value) && value.version === 1 && isRecord(value.links)) {
      const links: Record<string, DriveLink> = {};
      for (const [path, link] of Object.entries(value.links)) {
        if (isRecord(link) && typeof link.fileId === "string" && typeof link.sha256 === "string") links[path] = link as DriveLink;
      }
      return { version: 1, links };
    }
  } catch {
    // Missing or unreadable: start empty.
  }
  return { version: 1, links: {} };
}

async function hashHandle(handle: FileHandle) {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const buffer = new Uint8Array(1024 * 1024);
  let size = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, size);
    if (!bytesRead) break;
    const bytes = buffer.subarray(0, bytesRead);
    sha256.update(bytes);
    md5.update(bytes);
    size += bytesRead;
  }
  return { sha256: sha256.digest("hex"), md5: md5.digest("hex"), size };
}

async function hashFile(path: string) {
  const handle = await open(path, "r");
  try {
    return await hashHandle(handle);
  } finally {
    await handle.close();
  }
}

/** No pathname remains when transferred bytes enter this host-owned staging file. */
async function privateDriveFile(config: ServerConfig) {
  const folder = runtimeStorageDir(config);
  await mkdir(folder, { recursive: true });
  const path = join(folder, `.drive-transfer-${randomBytes(16).toString("hex")}`);
  const handle = await open(path, "wx+", 0o600);
  try {
    await rm(path);
    return handle;
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, offset: number) {
  for (let written = 0; written < bytes.byteLength;) {
    const part = await handle.write(bytes, written, bytes.byteLength - written, offset + written);
    if (!part.bytesWritten) throw new ApiError(500, "file_write_failed", "Could not write the file completely.");
    written += part.bytesWritten;
  }
}

async function copyHandles(source: FileHandle, target: FileHandle, size: number, signal?: AbortSignal) {
  const buffer = new Uint8Array(1024 * 1024);
  for (let offset = 0; offset < size;) {
    signal?.throwIfAborted();
    const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw new ApiError(409, "local_changes", "The file changed while transferring. Try again once it is saved.");
    await writeAll(target, buffer.subarray(0, bytesRead), offset);
    offset += bytesRead;
  }
}

/** An unlinked host-owned copy keeps uploads on the exact bytes hashed before confirmation. */
async function snapshotForPush(config: ServerConfig, source: FileHandle, expected: { sha256: string; size: number }, signal?: AbortSignal) {
  const snapshot = await privateDriveFile(config);
  try {
    await copyHandles(source, snapshot, expected.size, signal);
    if ((await hashHandle(snapshot)).sha256 !== expected.sha256) {
      throw new ApiError(409, "local_changes", "The local file changed before confirmation. Nothing was uploaded; try again once it is saved.");
    }
    return snapshot;
  } catch (error) {
    await snapshot.close();
    throw error;
  }
}

async function realRoots(config: ServerConfig) {
  const roots: string[] = [];
  for (const root of allowedRoots(config)) {
    try {
      roots.push(await realpath(root));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  return roots;
}

function workspaceBase(config: ServerConfig, context: Record<string, unknown>) {
  const base = searchRoots(config, context, allowedRoots(config))[0];
  if (!base) throw new ApiError(400, "invalid_payload", "No authorized workspace roots are available.");
  return base;
}

function displayPath(config: ServerConfig, context: Record<string, unknown>, path: string) {
  const base = searchRoots(config, context, allowedRoots(config))[0];
  if (!base) return path;
  if (isWithinRoot(path, base)) return relative(base, path);
  try {
    // Link records hold real paths; a workspace may be opened through a symlink.
    const real = realpathSync(base);
    if (isWithinRoot(path, real)) return relative(real, path);
  } catch {
    // Missing base: show the full path.
  }
  return path;
}

/** Creates missing folders only below an existing directory that resolves inside an authorized root. */
async function resolvePullTarget(config: ServerConfig, context: Record<string, unknown>, requested: string | null, defaultName: string) {
  const base = workspaceBase(config, context);
  const candidate = requested ? (isAbsolute(requested) ? resolve(requested) : resolve(base, requested)) : resolve(base, "drive", defaultName);
  if (!allowedRoots(config).some((root) => isWithinRoot(candidate, root))) {
    throw new ApiError(403, "path_outside_workspace", "Files can only be saved inside an authorized workspace.");
  }
  const roots = await realRoots(config);
  let existing = dirname(candidate);
  const missing: string[] = [];
  while (true) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  if (!roots.some((root) => isWithinRoot(existing, root))) {
    throw new ApiError(403, "path_outside_workspace", "Files can only be saved inside an authorized workspace.");
  }
  const parent = join(existing, ...missing);
  await mkdir(parent, { recursive: true });
  const target = join(parent, basename(candidate));
  try {
    const info = await lstat(target);
    if (!info.isFile()) throw new ApiError(409, "path_not_file", "That path exists and is not a regular file.");
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
  }
  return target;
}

/** The destination was resolved to a real folder inside a root; refuse if a component has since become a symlink. */
async function assertStableFolder(config: ServerConfig, folder: string) {
  let real = "";
  try {
    real = await realpath(folder);
  } catch {
    // Missing now: fall through to the refusal.
  }
  if (real !== folder || !(await realRoots(config)).some((root) => isWithinRoot(real, root))) {
    throw new ApiError(409, "workspace_changed", "The workspace folder changed during the transfer, so nothing was transferred. Try again.");
  }
}

/** The temporary file we opened is still the one in the checked folder. */
async function assertSameFile(path: string, opened: Stats) {
  const placed = await lstat(path).catch(() => null);
  if (!placed || !placed.isFile() || placed.ino !== opened.ino || placed.dev !== opened.dev) {
    throw new ApiError(409, "workspace_changed", "The workspace folder changed during the transfer, so nothing was transferred. Try again.");
  }
}

/** Opens an authorized file once, without following a planted symlink, for both hashing and upload. */
async function openAuthorizedFile(config: ServerConfig, path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    await assertStableFolder(config, dirname(path));
    await assertSameFile(path, opened);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function sameState(before: Stats | null, now: Stats | null) {
  if (!before || !now) return before === now;
  return before.ino === now.ino && before.dev === now.dev && before.size === now.size && before.mtimeMs === now.mtimeMs;
}

function safeFileName(name: string, extension: string | null) {
  let safe = name.replace(/[/\\\x00-\x1f\x7f]/g, "_").trim().slice(0, 200);
  if (!safe || safe === "." || safe === "..") safe = "drive-file";
  if (extension && !safe.toLowerCase().endsWith(extension)) safe = `${safe}${extension}`;
  return safe;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function denRequest(
  config: ServerConfig,
  dependencies: CloudUploadDependencies,
  suffix: string,
  init: { method?: string; query?: Record<string, string | undefined>; headers?: Record<string, string>; body?: unknown; bytes?: Uint8Array<ArrayBuffer> } = {},
) {
  dependencies.signal?.throwIfAborted();
  const endpoint = await cloudUploadEndpoint(config, suffix, dependencies);
  for (const [key, value] of Object.entries(init.query ?? {})) if (value !== undefined) endpoint.url.searchParams.set(key, value);
  try {
    return await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
      method: init.method ?? "GET",
      redirect: "error",
      headers: {
        authorization: endpoint.authorization,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.bytes ? { "content-type": "application/octet-stream" } : {}),
        ...init.headers,
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.bytes ? { body: init.bytes } : {}),
      signal: dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(DEN_TIMEOUT_MS)]) : AbortSignal.timeout(DEN_TIMEOUT_MS),
    });
  } catch (error) {
    dependencies.signal?.throwIfAborted();
    throw new ApiError(502, "cloud_unreachable", "OpenWork Cloud could not be reached. Try again later.", { cause: error instanceof Error ? error.message : String(error) });
  }
}

async function denFailure(response: Response): Promise<never> {
  const payload: unknown = await response.json().catch(() => null);
  const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "cloud_drive_failed";
  const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : `OpenWork Cloud returned HTTP ${response.status}.`;
  const details = isRecord(payload) ? Object.fromEntries(Object.entries(payload).filter(([key]) => key === "currentRevision" || key === "modifiedTime")) : {};
  throw new ApiError(response.status, code, message, Object.keys(details).length ? details : undefined);
}

async function denJson(config: ServerConfig, dependencies: CloudUploadDependencies, suffix: string, init: Parameters<typeof denRequest>[3] = {}) {
  const response = await denRequest(config, dependencies, suffix, init);
  if (!response.ok) return denFailure(response);
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload)) throw new ApiError(502, "cloud_drive_failed", "OpenWork Cloud returned an invalid response.");
  return payload;
}

function parseDownloadInfo(payload: Record<string, unknown>): DownloadInfo {
  const file = payload.file;
  const download = payload.download;
  if (!isRecord(file) || !isRecord(download) || typeof file.id !== "string" || typeof file.name !== "string" || typeof file.mimeType !== "string" || typeof download.mimeType !== "string") {
    throw new ApiError(502, "cloud_drive_failed", "OpenWork Cloud returned an invalid Drive file description.");
  }
  const size = typeof download.size === "number" && Number.isSafeInteger(download.size) ? download.size : null;
  return {
    file: {
      id: file.id, driveId: "", name: file.name, mimeType: file.mimeType, native: file.native === true,
      revision: stringOrNull(file.revision), md5Checksum: stringOrNull(file.md5Checksum),
      size: typeof file.size === "number" ? file.size : null, webViewLink: stringOrNull(file.webViewLink),
      parents: Array.isArray(file.parents) ? file.parents.filter((parent): parent is string => typeof parent === "string") : [],
    },
    download: {
      format: stringOrNull(download.format), mimeType: download.mimeType, extension: stringOrNull(download.extension), size,
      exported: download.exported === true,
      maxBytes: typeof download.maxBytes === "number" ? Math.min(download.maxBytes, GOOGLE_DRIVE_PULL_MAX_BYTES) : GOOGLE_DRIVE_PULL_MAX_BYTES,
    },
  };
}

/** Microsoft files have no native formats or md5; a PDF conversion is the only export. */
function parseMicrosoftDownloadInfo(payload: Record<string, unknown>): DownloadInfo {
  const file = payload.file;
  const download = payload.download;
  if (!isRecord(file) || !isRecord(download) || typeof file.id !== "string" || !MICROSOFT_ID.test(file.id) || typeof file.name !== "string"
    || typeof file.mimeType !== "string" || typeof download.mimeType !== "string" || (file.driveId !== "" && (typeof file.driveId !== "string" || !MICROSOFT_ID.test(file.driveId)))) {
    throw new ApiError(502, "cloud_drive_failed", "OpenWork Cloud returned an invalid OneDrive or SharePoint file description.");
  }
  const size = typeof download.size === "number" && Number.isSafeInteger(download.size) ? download.size : null;
  return {
    file: {
      id: file.id, driveId: file.driveId, name: file.name, mimeType: file.mimeType, native: false,
      revision: stringOrNull(file.revision), md5Checksum: null,
      size: typeof file.size === "number" ? file.size : null, webViewLink: stringOrNull(file.webUrl),
      parents: typeof file.parentId === "string" && file.parentId ? [file.parentId] : [],
    },
    download: {
      format: download.format === "pdf" ? "pdf" : null, mimeType: download.mimeType, extension: stringOrNull(download.extension), size,
      exported: download.exported === true,
      maxBytes: typeof download.maxBytes === "number" ? Math.min(download.maxBytes, MICROSOFT_DRIVE_TRANSFER_MAX_BYTES) : MICROSOFT_DRIVE_TRANSFER_MAX_BYTES,
    },
  };
}

async function describe(config: ServerConfig, dependencies: CloudUploadDependencies, target: FileTarget, format: string | undefined, connectionId: string | undefined) {
  if ("fileId" in target) {
    return parseDownloadInfo(await denJson(config, dependencies, `/v1/direct-downloads/google-workspace/drive-files/${target.fileId}`, { query: { format, connectionId } }));
  }
  const query = "url" in target ? { url: target.url } : { itemId: target.itemId, driveId: target.driveId };
  return parseMicrosoftDownloadInfo(await denJson(config, dependencies, "/v1/direct-downloads/microsoft-365/drive-files", { query: { ...query, format, connectionId } }));
}

/** The same file again, by the ids its first description returned. */
function describedTarget(provider: Provider, info: DownloadInfo): FileTarget {
  return provider === "microsoft-365" ? { itemId: info.file.id, ...(info.file.driveId ? { driveId: info.file.driveId } : {}) } : { fileId: info.file.id };
}

function linkTarget(link: DriveLink): FileTarget {
  return link.provider === "microsoft-365" ? { itemId: link.fileId, ...(link.driveId ? { driveId: link.driveId } : {}) } : { fileId: link.fileId };
}

/** Ranged chunks for stored files, one stream for exports; the caller verifies size and md5. */
async function download(config: ServerConfig, dependencies: CloudUploadDependencies, provider: Provider, info: DownloadInfo, connectionId: string | undefined, handle: FileHandle) {
  const format = info.download.exported ? info.download.format ?? undefined : undefined;
  const microsoft = provider === "microsoft-365";
  const suffix = microsoft ? "/v1/direct-downloads/microsoft-365/drive-files/content" : `/v1/direct-downloads/google-workspace/drive-files/${info.file.id}/content`;
  const query = microsoft ? { itemId: info.file.id, driveId: info.file.driveId || undefined, format, connectionId } : { format, connectionId };
  const chunkBytes = microsoft ? MICROSOFT_DRIVE_PULL_CHUNK_BYTES : GOOGLE_DRIVE_PULL_CHUNK_BYTES;
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let written = 0;
  const write = async (bytes: Uint8Array) => {
    if (written + bytes.byteLength > info.download.maxBytes) throw new ApiError(413, "file_too_large", `Pulls support files up to ${info.download.maxBytes} bytes.`);
    await writeAll(handle, bytes, written);
    sha256.update(bytes);
    md5.update(bytes);
    written += bytes.byteLength;
  };
  const size = info.download.size;
  if (!info.download.exported && size !== null) {
    for (let start = 0; start < size; start += chunkBytes) {
      const end = Math.min(size, start + chunkBytes) - 1;
      const response = await denRequest(config, dependencies, suffix, { query, headers: { range: `bytes=${start}-${end}` } });
      if (!response.ok) await denFailure(response);
      if (response.status !== 206 && !(response.status === 200 && start === 0 && end === size - 1)) {
        await response.body?.cancel();
        throw new ApiError(502, "drive_download_incomplete", "The requested part of the file did not arrive. Try the pull again.");
      }
      const bytes = new Uint8Array(await response.arrayBuffer().catch(() => {
        throw new ApiError(502, "drive_download_incomplete", "The download stopped early. Try the pull again.");
      }));
      if (bytes.byteLength !== end - start + 1) throw new ApiError(502, "drive_download_incomplete", "The download stopped early. Try the pull again.");
      await write(bytes);
    }
  } else {
    const response = await denRequest(config, dependencies, suffix, { query });
    if (!response.ok) await denFailure(response);
    if (!response.body) throw new ApiError(502, "drive_download_incomplete", "No file content arrived.");
    try {
      for await (const chunk of response.body) await write(chunk);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "drive_download_incomplete", "The download stopped early. Try the pull again.");
    }
  }
  return { size: written, sha256: sha256.digest("hex"), md5: md5.digest("hex") };
}

function verified(info: DownloadInfo, saved: { size: number; md5: string }) {
  return (info.download.size === null || saved.size === info.download.size)
    && (info.download.exported || !info.file.md5Checksum || saved.md5 === info.file.md5Checksum);
}

async function pullDriveFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudUploadDependencies) {
  const provider = providerFor(args);
  let fileTarget: FileTarget = provider === "microsoft-365" ? microsoftTarget(args) : { fileId: parseDriveFileId(readArgString(args, "fileId")) };
  const format = readArgString(args, "format") || undefined;
  if (provider === "microsoft-365" && format && format !== "pdf") throw new ApiError(400, "invalid_payload", "OneDrive and SharePoint files can only be converted to pdf; omit format to pull the file as it is.");
  if (format && !/^[a-z]{2,5}$/.test(format)) throw new ApiError(400, "invalid_payload", "format must be an export format such as xlsx, csv, docx, md, txt, pptx or pdf.");
  const connectionId = optionalConnectionId(args, provider);
  const overwrite = args.overwrite === true;
  const requested = readArgString(args, "path") || null;
  const service = SERVICE_NAME[provider];

  let info = await describe(config, dependencies, fileTarget, format, connectionId);
  fileTarget = describedTarget(provider, info);
  // A Microsoft PDF conversion of Plan.docx saves as Plan.pdf; Google files have no extension to replace.
  const converted = provider === "microsoft-365" && info.download.exported;
  const sourceName = converted ? info.file.name.slice(0, info.file.name.length - extname(info.file.name).length) || info.file.name : info.file.name;
  const name = safeFileName(sourceName, info.download.exported ? info.download.extension : null);
  const links = await readLinks(config);
  let target = await resolvePullTarget(config, context, requested, name);
  if (!requested) {
    // The default name may belong to another file: use the first free name, or the one already holding this file.
    const extension = extname(name);
    const stem = name.slice(0, name.length - extension.length);
    for (let copy = 2; await exists(target) && !sameDriveFile(links.links[target], provider, info); copy += 1) {
      if (copy > 50) throw new ApiError(409, "path_exists", "Choose a path for this file; the default names are taken.");
      target = await resolvePullTarget(config, context, null, `${stem} (${copy})${extension}`);
    }
  }
  // One check for whichever path was chosen: never discard unpushed edits or another file silently.
  const before = await lstat(target).catch(() => null);
  if (before) {
    const link = links.links[target];
    if (sameDriveFile(link, provider, info)) {
      const local = await hashFile(target);
      if (local.sha256 === link.sha256 && link.revision !== null && link.revision === info.file.revision && link.format === info.download.format) {
        return pullResult(config, context, target, info, local.size, true);
      }
      if (!overwrite && local.sha256 !== link.sha256) {
        throw new ApiError(409, "local_changes", `The local copy has edits that are not in ${service}. Push them first, or pull with overwrite: true to discard them.`, { path: displayPath(config, context, target) });
      }
    } else if (!overwrite) {
      throw new ApiError(409, "path_exists", "A different file already exists at that path. Choose another path, or pass overwrite: true to replace it.");
    }
  }

  let saved: Awaited<ReturnType<typeof download>> | null = null;
  await confirmDriveTransfer(config, { provider, action: before && overwrite ? "overwrite" : "pull", path: target, fileId: info.file.id, name: info.file.name, webViewLink: info.file.webViewLink }, dependencies.signal);
  for (let attempt = 1; attempt <= 2 && !saved; attempt += 1) {
    const temporary = await privateDriveFile(config);
    try {
      const result = await download(config, dependencies, provider, info, connectionId, temporary);
      if (verified(info, result)) {
        if (!sameState(before, await lstat(target).catch(() => null))) {
          throw new ApiError(409, "local_changes", "The file at that path changed while pulling, so it was not replaced. Pull again once it is saved or pushed.", { path: displayPath(config, context, target) });
        }
        const root = (await realRoots(config)).find((candidate) => isWithinRoot(target, candidate));
        if (!root) throw new ApiError(403, "path_outside_workspace", "Files can only be saved inside an authorized workspace.");
        // Match the workbook/attachment writer: prove the opened inode before
        // truncating or writing, then use only its handle. No path-based rename
        // can follow a swapped parent into another file.
        let destination: Awaited<ReturnType<typeof openWorkspaceFileForWriting>>;
        try {
          destination = await openWorkspaceFileForWriting(root, target, before, "Drive download");
        } catch (error) {
          if (error instanceof WorkspaceFileError) throw new ApiError(409, "workspace_changed", error.message);
          throw error;
        }
        try {
          if (before && !sameState(before, destination.info)) throw new ApiError(409, "local_changes", "The local file changed while pulling. It was not replaced.");
          await destination.handle.truncate(0);
          await copyHandles(temporary, destination.handle, result.size, dependencies.signal);
          if (!(await proveHandleInPlace(await destination.handle.stat(), target, root))) {
            throw new ApiError(409, "workspace_changed", "The workspace folder changed during the transfer. Check the local copy before trying again.");
          }
          saved = result;
        } finally {
          await destination.handle.close();
        }
      }
    } catch (error) {
      // A file that changed (or shrank) mid-download fails a chunk: retry once from its new revision.
      const transient = error instanceof ApiError && ["drive_download_incomplete", "google_api_error", "microsoft_graph_error", "cloud_drive_failed"].includes(error.code);
      if (!transient || attempt === 2) throw error;
      const fresh = await describe(config, dependencies, fileTarget, format, connectionId);
      if (fresh.file.revision === info.file.revision) throw error;
      info = fresh;
      continue;
    } finally {
      await temporary.close();
    }
    // Size or md5 did not match: the file changed while downloading.
    if (!saved && attempt === 1) info = await describe(config, dependencies, fileTarget, format, connectionId);
  }
  if (!saved) throw new ApiError(409, "drive_changed_during_download", `The file kept changing in ${service} while downloading. Try again later.`);

  const link: DriveLink = {
    ...(provider === "microsoft-365" ? { provider, driveId: info.file.driveId } : {}),
    fileId: info.file.id, connectionId: connectionId ?? null, name: info.file.name, driveMimeType: info.file.mimeType,
    native: info.file.native, format: info.download.format, localMimeType: info.download.mimeType,
    revision: info.file.revision, md5Checksum: info.file.md5Checksum, sha256: saved.sha256, size: saved.size,
    parents: info.file.parents, webViewLink: info.file.webViewLink, pulledAt: new Date().toISOString(),
  };
  await withLinks(config, (current) => {
    current.links[target] = link;
  });
  return pullResult(config, context, target, info, saved.size, false);
}

function pullResult(config: ServerConfig, context: Record<string, unknown>, target: string, info: DownloadInfo, size: number, upToDate: boolean) {
  return {
    ok: true,
    path: displayPath(config, context, target),
    size,
    mimeType: info.download.mimeType,
    ...(info.download.exported ? { exportedAs: info.download.format } : {}),
    ...(upToDate ? { upToDate: true } : {}),
    file: {
      id: info.file.id, ...(info.file.driveId ? { driveId: info.file.driveId } : {}),
      name: info.file.name, mimeType: info.file.mimeType, webViewLink: info.file.webViewLink, revision: info.file.revision,
    },
  };
}

/** Whether a link record is the described file: same provider, id and (for Microsoft) drive. */
function sameDriveFile(link: DriveLink | undefined, provider: Provider, info: DownloadInfo) {
  if (!link || (link.provider ?? "google-workspace") !== provider || link.fileId !== info.file.id) return false;
  return provider !== "microsoft-365" || (link.driveId ?? "") === info.file.driveId;
}

async function linkedEntries(config: ServerConfig, context: Record<string, unknown>, requested: string) {
  const links = await readLinks(config);
  // Link records hold real paths, so compare against the real roots too.
  const roots = [...allowedRoots(config), ...await realRoots(config)];
  let entries = Object.entries(links.links).filter(([path]) => roots.some((root) => isWithinRoot(path, root)));
  if (requested) {
    const base = workspaceBase(config, context);
    const candidates = new Set([isAbsolute(requested) ? resolve(requested) : resolve(base, requested)]);
    try {
      candidates.add(await realpath([...candidates][0]));
    } catch {
      // A deleted local copy keeps its link: try the real workspace folder instead.
      if (!isAbsolute(requested)) candidates.add(resolve(await realpath(base).catch(() => base), requested));
    }
    entries = entries.filter(([path]) => candidates.has(path));
    if (!entries.length) throw new ApiError(404, "not_linked", "That file was not pulled from Drive. Pull it first, or upload it as a new file with drive_upload_file.");
  }
  return entries;
}

/** The format a pull exported, so a status check or push describes the same export. */
function linkFormat(link: DriveLink) {
  return link.provider === "microsoft-365" || link.native ? link.format ?? undefined : undefined;
}

async function driveFileStatus(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudUploadDependencies) {
  const entries = await linkedEntries(config, context, readArgString(args, "path"));
  const files = [];
  for (const [path, link] of entries.slice(0, MAX_STATUS_FILES)) {
    let local: "unchanged" | "edited" | "missing" = "missing";
    if (await exists(path)) local = (await hashFile(path)).sha256 === link.sha256 ? "unchanged" : "edited";
    let drive: "unchanged" | "changed" | "trashed" | "unavailable" = "unavailable";
    let currentRevision: string | null = null;
    let note: string | undefined;
    try {
      const info = await describe(config, dependencies, linkTarget(link), linkFormat(link), link.connectionId ?? undefined);
      currentRevision = info.file.revision;
      drive = currentRevision === link.revision ? "unchanged" : "changed";
    } catch (error) {
      if (error instanceof ApiError && error.code === "drive_file_trashed") drive = "trashed";
      else note = error instanceof Error ? error.message : String(error);
    }
    files.push({
      path: displayPath(config, context, path), provider: link.provider ?? "google-workspace", fileId: link.fileId, ...(link.driveId ? { driveId: link.driveId } : {}), name: link.name, webViewLink: link.webViewLink,
      local, drive, revision: link.revision, currentRevision, ...(note ? { note } : {}),
    });
  }
  return { ok: true, files, ...(entries.length > MAX_STATUS_FILES ? { truncated: true } : {}) };
}

// One push per local file at a time, so two pushes cannot both pass the revision check.
const pushing = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (pushing.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  pushing.set(key, next);
  try {
    return await next;
  } finally {
    if (pushing.get(key) === next) pushing.delete(key);
  }
}

function copyName(link: DriveLink, requested: string, convert: boolean) {
  if (requested) return requested.replace(/[/\\\x00-\x1f\x7f]/g, "_").slice(0, 255);
  if (convert || link.native) return `${link.name} (edited)`;
  const extension = extname(link.name);
  return `${link.name.slice(0, link.name.length - extension.length)} (edited)${extension}`;
}

async function pushDriveFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudUploadDependencies) {
  const requested = readArgString(args, "path");
  if (!requested) throw new ApiError(400, "invalid_payload", "path is required.");
  const path = await resolveAuthorizedFile(config, context, requested, GOOGLE_DRIVE_UPLOAD_MAX_BYTES);
  return oneAtATime(path, async () => {
    const handle = await openAuthorizedFile(config, path);
    try {
      return await pushOpenFile(config, args, context, dependencies, path, handle);
    } finally {
      await handle.close();
    }
  });
}

async function pushOpenFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudUploadDependencies, path: string, handle: FileHandle) {
  const link = (await readLinks(config)).links[path];
  if (!link) throw new ApiError(409, "not_linked", "That file was not pulled from Drive. Upload it as a new file with drive_upload_file instead.");
  if (link.provider === "microsoft-365") return pushMicrosoftFile(config, args, context, dependencies, path, handle, link);
  if (!DRIVE_ID.test(link.fileId) || (link.connectionId !== null && !CONNECTION_ID.test(link.connectionId))) {
    throw new ApiError(409, "invalid_link", "The saved Drive link is invalid. Pull the file again before saving.");
  }
  const modeArg = readArgString(args, "mode");
  if (modeArg && modeArg !== "replace" && modeArg !== "copy") throw new ApiError(400, "invalid_payload", "mode must be replace or copy.");
  const mode = modeArg || (link.native ? "copy" : "replace");
  if (mode === "replace" && link.native) {
    throw new ApiError(400, "native_file_replace_unsupported", "Google Docs, Sheets and Slides files cannot be replaced by an uploaded file. Push with mode copy to save a new Google file next to it, or edit a Sheet with the Sheets values actions.");
  }
  // Replacing always names the pulled revision: nothing the model passes can skip the newer-version check.
  if (mode === "replace" && !link.revision) {
    throw new ApiError(409, "revision_unknown", "Drive reported no revision when this file was pulled, so newer Drive changes could not be detected. Pull it again, or save the edits as a copy.");
  }
  const local = await hashHandle(handle);
  if (mode === "replace" && local.sha256 === link.sha256) {
    return { ok: true, unchanged: true, path: displayPath(config, context, path), file: { id: link.fileId, name: link.name, webViewLink: link.webViewLink, revision: link.revision } };
  }
  const snapshot = await snapshotForPush(config, handle, local, dependencies.signal);
  try {
    const remote = await describe(config, dependencies, linkTarget(link), linkFormat(link), link.connectionId ?? undefined);
    if (remote.file.id !== link.fileId) throw new ApiError(409, "drive_conflict", "The Drive target changed. Pull it again before saving.");
    if (mode === "replace" && remote.file.native) throw new ApiError(400, "native_file_replace_unsupported", "Save this Google file as a copy instead.");
    const target = { ...link, name: remote.file.name, driveMimeType: remote.file.mimeType, native: remote.file.native, parents: remote.file.parents };
    const convert = mode === "copy" && target.native && (CONVERTIBLE_FORMATS[target.driveMimeType] ?? []).includes(link.format ?? "");
    await confirmDriveTransfer(config, { provider: "google-workspace", action: "push", path, fileId: remote.file.id, name: remote.file.name, webViewLink: remote.file.webViewLink, mode: mode === "copy" ? "copy" : "replace" }, dependencies.signal);
    await assertStableFolder(config, dirname(path));
    await assertSameFile(path, await handle.stat());
    if ((await hashHandle(handle)).sha256 !== local.sha256) {
      throw new ApiError(409, "local_changes", "The local file changed while confirmation was open. Nothing was uploaded; review the edits and save again.");
    }
    const mimeType = remote.download.mimeType || mimeTypeForPath(path);
    const name = mode === "copy" ? copyName(target, readArgString(args, "name"), convert) : basename(path);
    const session = await denJson(config, dependencies, "/v1/direct-uploads/google-workspace/drive-upload-sessions", {
      method: "POST",
      body: {
        name, size: local.size, mimeType,
        ...(link.connectionId ? { connectionId: link.connectionId } : {}),
        ...(mode === "replace"
          ? { fileId: link.fileId, baseRevision: link.revision }
          : { ...(target.parents[0] ? { folderId: target.parents[0] } : {}), ...(convert ? { convertTo: target.driveMimeType } : {}) }),
      },
    });
    if (typeof session.uploadUrl !== "string" || session.size !== local.size) throw new ApiError(502, "invalid_upload_session", "OpenWork Cloud returned an invalid upload session.");
    const receipt = await uploadDriveResumableFile({ path, file: snapshot, size: local.size, mimeType, uploadUrl: session.uploadUrl, fetch: dependencies.fetchImpl ?? externalFetch, signal: dependencies.signal });
    const file = receipt.file;
    if (file.md5Checksum && !convert && file.md5Checksum !== local.md5) {
      throw new ApiError(502, "drive_upload_unverified", "Drive saved different bytes than the local file. Check the file in Drive before trying again.", { fileId: file.id });
    }
    const revision = file.headRevisionId ?? file.version ?? null;
    const driveMimeType = file.mimeType ?? (convert ? target.driveMimeType : mimeType);
    await withLinks(config, (current) => {
      current.links[path] = {
        ...link,
        fileId: file.id,
        name: file.name ?? name,
        driveMimeType,
        native: driveMimeType.startsWith("application/vnd.google-apps."),
        format: driveMimeType.startsWith("application/vnd.google-apps.") ? link.format : null,
        revision,
        md5Checksum: file.md5Checksum ?? null,
        sha256: local.sha256,
        size: local.size,
        webViewLink: file.webViewLink ?? (mode === "replace" ? link.webViewLink : null),
        pushedAt: new Date().toISOString(),
      };
    });
    const replaces = isRecord(session.replaces) ? session.replaces : null;
    return {
      ok: true, mode, path: displayPath(config, context, path), size: local.size,
      file: { id: file.id, name: file.name ?? name, mimeType: driveMimeType, webViewLink: file.webViewLink ?? null, revision },
      ...(mode === "replace" ? { previousRevision: stringOrNull(replaces?.previousRevision) } : { copiedFrom: link.fileId }),
    };
  } finally {
    await snapshot.close();
  }
}

type RelayProgress = { status: "partial"; nextOffset: number } | { status: "complete"; file: Record<string, unknown> & { id: string } };

/** One relay answer: progress, the saved file, "uncertain" (ask how much arrived), or a definite refusal (thrown). */
async function relayProgress(response: Response): Promise<RelayProgress | "uncertain"> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : "";
    if (response.status >= 500 || code === "upload_out_of_order") return "uncertain";
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : `OpenWork Cloud returned HTTP ${response.status}.`;
    const details = isRecord(payload) ? Object.fromEntries(Object.entries(payload).filter(([key]) => key === "currentRevision" || key === "modifiedTime")) : {};
    throw new ApiError(response.status, code || "cloud_drive_failed", message, Object.keys(details).length ? details : undefined);
  }
  if (isRecord(payload) && payload.status === "partial" && typeof payload.nextOffset === "number" && Number.isSafeInteger(payload.nextOffset)) {
    return { status: "partial", nextOffset: payload.nextOffset };
  }
  if (isRecord(payload) && payload.status === "complete" && isRecord(payload.file) && typeof payload.file.id === "string" && MICROSOFT_ID.test(payload.file.id)) {
    return { status: "complete", file: payload.file as Record<string, unknown> & { id: string } };
  }
  return "uncertain";
}

/** Parts go to OpenWork Cloud, which holds Microsoft's session URL. An uncertain part asks how much arrived; it never starts another upload. */
async function uploadMicrosoftRelayFile(config: ServerConfig, dependencies: CloudUploadDependencies, input: { token: string; file: FileHandle; size: number; chunkBytes: number }) {
  const suffix = "/v1/direct-uploads/microsoft-365/drive-upload-sessions/content";
  const query = { token: input.token };
  const unconfirmed = () => new ApiError(502, "drive_upload_unconfirmed", "Microsoft did not confirm the upload. Check the file before retrying; no new upload was started.");
  let offset = 0;
  let recoveries = 0;
  while (true) {
    dependencies.signal?.throwIfAborted();
    const length = Math.min(input.chunkBytes, input.size - offset);
    const bytes = new Uint8Array(length);
    for (let read = 0; read < length;) {
      const part = await input.file.read(bytes, read, length - read, offset + read);
      if (!part.bytesRead) throw new ApiError(409, "file_changed", "The file was truncated during upload.");
      read += part.bytesRead;
    }
    let result: RelayProgress | "uncertain";
    try {
      result = await relayProgress(await denRequest(config, dependencies, suffix, {
        method: "PUT", query, headers: { "content-range": `bytes ${offset}-${offset + length - 1}/${input.size}` }, bytes,
      }));
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "cloud_unreachable") throw error;
      result = "uncertain";
    }
    if (result === "uncertain") {
      if (++recoveries > 2) throw unconfirmed();
      try {
        result = await relayProgress(await denRequest(config, dependencies, suffix, { query }));
      } catch (error) {
        if (error instanceof ApiError && error.code === "cloud_unreachable") throw unconfirmed();
        throw error;
      }
      if (result === "uncertain") throw unconfirmed();
    }
    if (result.status === "complete") return result.file;
    if (result.nextOffset < 0 || result.nextOffset >= input.size) throw unconfirmed();
    if (result.nextOffset <= offset && ++recoveries > 2) throw new ApiError(502, "drive_upload_unconfirmed", "Microsoft's upload made no progress. Completion is not confirmed; check the file before retrying.");
    offset = result.nextOffset;
  }
}

/** Office files on OneDrive and SharePoint are ordinary files, so they are replaced in place; only a PDF conversion goes back as a copy. */
async function pushMicrosoftFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudUploadDependencies, path: string, handle: FileHandle, link: DriveLink) {
  if (!MICROSOFT_ID.test(link.fileId) || (link.driveId && !MICROSOFT_ID.test(link.driveId)) || (link.connectionId !== null && !MICROSOFT_CONNECTION_ID.test(link.connectionId))) {
    throw new ApiError(409, "invalid_link", "The saved OneDrive or SharePoint link is invalid. Pull the file again before saving.");
  }
  const modeArg = readArgString(args, "mode");
  if (modeArg && modeArg !== "replace" && modeArg !== "copy") throw new ApiError(400, "invalid_payload", "mode must be replace or copy.");
  const converted = link.format !== null;
  const mode = modeArg || (converted ? "copy" : "replace");
  if (mode === "replace" && converted) {
    throw new ApiError(400, "converted_file_replace_unsupported", "A PDF made from this file cannot replace the original. Push with mode copy to save the PDF next to it.");
  }
  // Replacing always names the pulled eTag: nothing the model passes can skip the newer-version check.
  if (mode === "replace" && !link.revision) {
    throw new ApiError(409, "revision_unknown", "Microsoft reported no revision when this file was pulled, so newer changes could not be detected. Pull it again, or save the edits as a copy.");
  }
  const local = await hashHandle(handle);
  if (local.size > MICROSOFT_DRIVE_TRANSFER_MAX_BYTES) {
    throw new ApiError(413, "file_too_large", `Saving to OneDrive or SharePoint supports files up to ${MICROSOFT_DRIVE_TRANSFER_MAX_BYTES} bytes.`);
  }
  if (mode === "replace" && local.sha256 === link.sha256) {
    return { ok: true, unchanged: true, path: displayPath(config, context, path), file: { id: link.fileId, driveId: link.driveId ?? "", name: link.name, webViewLink: link.webViewLink, revision: link.revision } };
  }
  const snapshot = await snapshotForPush(config, handle, local, dependencies.signal);
  try {
    const remote = await describe(config, dependencies, linkTarget(link), undefined, link.connectionId ?? undefined);
    if (remote.file.id !== link.fileId) throw new ApiError(409, "drive_conflict", "The OneDrive or SharePoint target changed. Pull it again before saving.");
    await confirmDriveTransfer(config, { provider: "microsoft-365", action: "push", path, fileId: remote.file.id, name: remote.file.name, webViewLink: remote.file.webViewLink, mode: mode === "copy" ? "copy" : "replace" }, dependencies.signal);
    await assertStableFolder(config, dirname(path));
    await assertSameFile(path, await handle.stat());
    if ((await hashHandle(handle)).sha256 !== local.sha256) {
      throw new ApiError(409, "local_changes", "The local file changed while confirmation was open. Nothing was uploaded; review the edits and save again.");
    }
    const extension = converted ? ".pdf" : extname(remote.file.name);
    const stem = remote.file.name.slice(0, remote.file.name.length - extname(remote.file.name).length);
    const requestedName = readArgString(args, "name").replace(/[/\\\x00-\x1f\x7f]/g, "_").slice(0, 255);
    const name = requestedName || `${stem} (edited)${extension}`;
    const driveId = remote.file.driveId || link.driveId;
    const session = await denJson(config, dependencies, "/v1/direct-uploads/microsoft-365/drive-upload-sessions", {
      method: "POST",
      body: {
        size: local.size,
        ...(link.connectionId ? { connectionId: link.connectionId } : {}),
        ...(driveId ? { driveId } : {}),
        ...(mode === "replace"
          ? { itemId: link.fileId, baseRevision: link.revision }
          : { name, conflictBehavior: "rename", ...(remote.file.parents[0] ? { folderId: remote.file.parents[0] } : {}) }),
      },
    });
    const chunkBytes = session.chunkSize;
    if (typeof session.uploadToken !== "string" || session.size !== local.size || typeof chunkBytes !== "number"
      || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > MICROSOFT_DRIVE_UPLOAD_CHUNK_BYTES || chunkBytes % (320 * 1024) !== 0) {
      throw new ApiError(502, "invalid_upload_session", "OpenWork Cloud returned an invalid upload session.");
    }
    const file = await uploadMicrosoftRelayFile(config, dependencies, { token: session.uploadToken, file: snapshot, size: local.size, chunkBytes });
    const revision = stringOrNull(file.eTag);
    const savedName = typeof file.name === "string" && file.name ? file.name : name;
    const savedDriveId = typeof file.driveId === "string" && MICROSOFT_ID.test(file.driveId) ? file.driveId : driveId ?? "";
    const webViewLink = typeof file.webUrl === "string" && file.webUrl ? file.webUrl : mode === "replace" ? link.webViewLink : null;
    const driveMimeType = typeof file.mimeType === "string" && file.mimeType ? file.mimeType : link.driveMimeType;
    await withLinks(config, (current) => {
      current.links[path] = {
        ...link, provider: "microsoft-365", fileId: file.id, driveId: savedDriveId, name: savedName, driveMimeType, native: false,
        format: null, revision, md5Checksum: null, sha256: local.sha256, size: local.size, webViewLink, pushedAt: new Date().toISOString(),
      };
    });
    const replaces = isRecord(session.replaces) ? session.replaces : null;
    return {
      ok: true, mode, path: displayPath(config, context, path), size: local.size,
      file: { id: file.id, driveId: savedDriveId, name: savedName, mimeType: driveMimeType, webViewLink, revision },
      ...(mode === "replace" ? { previousRevision: stringOrNull(replaces?.previousRevision) } : { copiedFrom: link.fileId }),
    };
  } finally {
    await snapshot.close();
  }
}

export async function callDriveFileAction(
  config: ServerConfig,
  action: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies = {},
) {
  if (action === "drive_pull_file") return pullDriveFile(config, args, context, dependencies);
  if (action === "drive_file_status") return driveFileStatus(config, args, context, dependencies);
  if (action === "drive_push_file") return pushDriveFile(config, args, context, dependencies);
  return null;
}
