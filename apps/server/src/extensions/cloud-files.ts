import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { readConnectCloudMcp } from "../connect-state.js";
import { ApiError } from "../errors.js";
import { externalFetch } from "../server-fetch.js";
import type { ServerConfig } from "../types.js";
import { shortId } from "../utils.js";

export const OPENWORK_CLOUD_FILES_EXTENSION_ID = "openwork-cloud-files";
const FILE_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const CLOUD_FILE_TIMEOUT_MS = 2 * 60 * 1000;

export type CloudFileDependencies = {
  readCloudMcp?: typeof readConnectCloudMcp;
  fetchImpl?: typeof externalFetch;
};

export const OPENWORK_CLOUD_FILE_ACTIONS = [
  {
    extensionId: OPENWORK_CLOUD_FILES_EXTENSION_ID,
    action: "stage_file",
    title: "Stage a workspace file for a cloud capability",
    description: "Uploads a file from an authorized workspace path directly to OpenWork Cloud, outside model context. Returns fileRef; pass that opaque reference to Drive upload or Gmail draft capabilities.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path or absolute path under an authorized workspace root." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    extensionId: OPENWORK_CLOUD_FILES_EXTENSION_ID,
    action: "materialize_file",
    title: "Materialize a cloud file in the workspace",
    description: "Downloads an opaque fileRef directly from OpenWork Cloud into the active workspace inbox, outside model context. Returns the workspace path for Read, Bash, Docling, or other file tools.",
    inputSchema: {
      type: "object",
      properties: {
        fileRef: { type: "string", description: "Opaque fileRef returned by a cloud download capability." },
      },
      required: ["fileRef"],
      additionalProperties: false,
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function pushUniqueResolvedPath(paths: string[], path: string) {
  const trimmed = path.trim();
  if (!trimmed) return;
  const resolved = resolve(trimmed);
  if (!paths.includes(resolved)) paths.push(resolved);
}

function isWithinRoot(path: string, root: string) {
  const child = relative(root, path);
  return child === "" || (!!child && !child.startsWith("..") && !isAbsolute(child));
}

function allowedRoots(config: ServerConfig) {
  const roots: string[] = [];
  for (const workspace of config.workspaces) pushUniqueResolvedPath(roots, workspace.path);
  for (const root of config.authorizedRoots) pushUniqueResolvedPath(roots, root);
  return roots;
}

function searchRoots(config: ServerConfig, context: Record<string, unknown>, roots: string[]) {
  const candidates: string[] = [];
  const directory = readString(context, "directory");
  const worktree = readString(context, "worktree");
  if (directory) pushUniqueResolvedPath(candidates, directory);
  if (worktree) pushUniqueResolvedPath(candidates, worktree);
  for (const workspace of config.workspaces) pushUniqueResolvedPath(candidates, workspace.path);
  for (const root of roots) pushUniqueResolvedPath(candidates, root);
  return candidates.filter((candidate) => roots.some((root) => isWithinRoot(candidate, root)));
}

async function resolveAuthorizedFile(config: ServerConfig, context: Record<string, unknown>, requested: string) {
  const roots = allowedRoots(config);
  if (!roots.length) throw new ApiError(400, "invalid_payload", "No authorized workspace roots are available.");
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : searchRoots(config, context, roots).map((root) => resolve(root, requested));
  for (const candidate of candidates) {
    if (!roots.some((root) => isWithinRoot(candidate, root))) continue;
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      if (info.size < 1 || info.size > FILE_REFERENCE_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", `Cloud file references support files up to ${FILE_REFERENCE_MAX_BYTES} bytes.`, {
          size: info.size,
          maxBytes: FILE_REFERENCE_MAX_BYTES,
        });
      }
      return { path: candidate, size: info.size };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new ApiError(404, "file_not_found", "File was not found inside an authorized workspace root.", { path: requested });
}

function mimeTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (lower.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function cloudFileEndpoint(config: ServerConfig, suffix: string, dependencies: CloudFileDependencies) {
  const cloud = await (dependencies.readCloudMcp ?? readConnectCloudMcp)(config);
  const endpoint = readString(cloud, "url");
  const headers = isRecord(cloud?.headers) ? cloud.headers : null;
  const authorization = headers && typeof headers.Authorization === "string"
    ? headers.Authorization
    : headers && typeof headers.authorization === "string"
      ? headers.authorization
      : "";
  if (!endpoint || !authorization) {
    throw new ApiError(409, "cloud_not_connected", "OpenWork Cloud must be connected before staging or materializing files.");
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ApiError(409, "cloud_endpoint_invalid", "The configured OpenWork Cloud endpoint is invalid.");
  }
  const mcpSuffix = "/mcp/agent";
  if (!url.pathname.replace(/\/+$/, "").endsWith(mcpSuffix)) {
    throw new ApiError(409, "cloud_endpoint_invalid", "The configured OpenWork Cloud endpoint must end in /mcp/agent.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "").slice(0, -mcpSuffix.length)}${suffix}`;
  url.search = "";
  url.hash = "";
  return { url, authorization };
}

async function stageFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudFileDependencies) {
  const requested = readString(args, "path");
  if (!requested) throw new ApiError(400, "invalid_payload", "path is required.");
  const resolved = await resolveAuthorizedFile(config, context, requested);
  const bytes = await readFile(resolved.path);
  const filename = basename(resolved.path);
  const mimeType = mimeTypeForPath(filename);
  const form = new FormData();
  form.append("file", new File([bytes], filename, { type: mimeType }));
  form.append("filename", filename);
  form.append("mimeType", mimeType);
  const endpoint = await cloudFileEndpoint(config, "/v1/file-references", dependencies);
  const response = await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
    method: "POST",
    headers: { authorization: endpoint.authorization },
    body: form,
    signal: AbortSignal.timeout(CLOUD_FILE_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(payload) || typeof payload.fileRef !== "string") {
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
    throw new ApiError(response.status || 502, "cloud_file_stage_failed", `OpenWork Cloud could not stage the file: ${message}`);
  }
  return { ok: true, ...payload, sourcePath: requested };
}

function materializationRoot(config: ServerConfig, context: Record<string, unknown>) {
  const roots = allowedRoots(config);
  const directory = readString(context, "directory");
  if (directory) {
    const resolved = resolve(directory);
    if (roots.some((root) => isWithinRoot(resolved, root))) return resolved;
  }
  const workspace = config.workspaces.find((item) => roots.some((root) => isWithinRoot(resolve(item.path), root)));
  if (workspace) return resolve(workspace.path);
  throw new ApiError(400, "workspace_unavailable", "An active authorized workspace is required to materialize the file.");
}

async function materializeFile(config: ServerConfig, args: Record<string, unknown>, context: Record<string, unknown>, dependencies: CloudFileDependencies) {
  const fileRef = readString(args, "fileRef");
  if (!/^file_ref_[a-f0-9]{32}$/i.test(fileRef)) throw new ApiError(400, "invalid_payload", "A valid fileRef is required.");
  const endpoint = await cloudFileEndpoint(config, `/v1/file-references/${encodeURIComponent(fileRef)}/content`, dependencies);
  const response = await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
    headers: { authorization: endpoint.authorization },
    signal: AbortSignal.timeout(CLOUD_FILE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new ApiError(response.status || 502, "cloud_file_materialize_failed", `OpenWork Cloud could not materialize the file (HTTP ${response.status}).`);
  }
  const encodedFilename = response.headers.get("x-openwork-filename") ?? "attachment.bin";
  let filename = "attachment.bin";
  try {
    filename = decodeURIComponent(encodedFilename);
  } catch {
    // Keep the safe fallback.
  }
  filename = basename(filename).replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_") || "attachment.bin";
  const root = materializationRoot(config, context);
  const relativePath = join(".opencode", "openwork", "inbox", "cloud-downloads", `${fileRef}-${filename}`);
  const target = resolve(root, relativePath);
  if (!isWithinRoot(target, root)) throw new ApiError(400, "invalid_path", "Materialized file path escaped the workspace root.");
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${shortId()}`;
  try {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > FILE_REFERENCE_MAX_BYTES) {
      throw new ApiError(413, "file_too_large", "Materialized file exceeded the supported size.");
    }
    await writeFile(temporary, bytes, { flag: "wx" });
    const info = await stat(temporary);
    await rename(temporary, target);
    return {
      ok: true,
      fileRef,
      filename,
      mimeType: response.headers.get("content-type") ?? "application/octet-stream",
      bytes: info.size,
      sha256: response.headers.get("x-openwork-sha256"),
      workspacePath: relativePath,
      absolutePath: target,
    };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function callOpenWorkCloudFileAction(
  config: ServerConfig,
  action: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudFileDependencies = {},
) {
  if (action === "stage_file") return stageFile(config, args, context, dependencies);
  if (action === "materialize_file") return materializeFile(config, args, context, dependencies);
  return null;
}
