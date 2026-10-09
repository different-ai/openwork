import { readFile, realpath, stat } from "node:fs/promises";
import { GOOGLE_DRIVE_UPLOAD_MAX_BYTES } from "@openwork/types/google-drive-upload";
import { uploadDriveResumableFile } from "./drive-resumable-upload.js";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { readConnectCloudMcp } from "../connect-state.js";
import { ApiError } from "../errors.js";
import { externalFetch } from "../server-fetch.js";
import type { ServerConfig } from "../types.js";

export const OPENWORK_CLOUD_UPLOADS_EXTENSION_ID = "openwork-cloud-uploads";
const DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;
const DIRECT_UPLOAD_TIMEOUT_MS = 2 * 60 * 1000;

export type CloudUploadDependencies = {
  readCloudMcp?: typeof readConnectCloudMcp;
  fetchImpl?: typeof externalFetch;
  signal?: AbortSignal;
};

const workspacePathProperty = {
  type: "string",
  description: "Workspace-relative path or absolute path under an authorized workspace root.",
};

export const OPENWORK_CLOUD_UPLOAD_ACTIONS = [
  {
    extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID,
    action: "drive_upload_file",
    title: "Upload a workspace file to Google Drive",
    description: "Uploads a workspace file to Google Drive outside model context, preserving bytes, basename and MIME type without Office conversion. Files above 4 MiB use direct resumable transport when enabled for the organization (Google's limit is 5 TiB). connectionId selects the requested Google account; omit only to use the default. Never retry an unconfirmed upload automatically.",
    inputSchema: {
      type: "object",
      properties: {
        path: workspacePathProperty,
        folderId: { type: "string", description: "Optional Google Drive parent folder id." },
        connectionId: { type: "string", pattern: "^(google-workspace|emc_[A-Za-z0-9]+)$", description: "Selected native Google Workspace connection; omission uses the default. Unavailable selections never fall back to another account." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID,
    action: "gmail_create_draft_with_attachments",
    title: "Create a Gmail draft with workspace attachments",
    description: "Creates a reviewable Gmail draft with up to 4 MiB of attachments uploaded from authorized workspace paths through OpenWork Cloud outside model context. This does not send email. Pass connectionId to preserve the selected Google Workspace connection; omitting it uses the member's default connection.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        cc: { type: "string", description: "Optional comma-separated Cc recipients." },
        bcc: { type: "string", description: "Optional comma-separated Bcc recipients." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Plain-text draft body." },
        threadId: { type: "string", description: "Optional Gmail thread id for a reply draft." },
        connectionId: { type: "string", pattern: "^(google-workspace|emc_[A-Za-z0-9]+)$", description: "Optional selected native Google Workspace connection namespace." },
        paths: {
          type: "array",
          items: workspacePathProperty,
          minItems: 1,
          maxItems: 10,
          description: "One to ten authorized workspace file paths.",
        },
      },
      required: ["to", "subject", "body", "paths"],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

function readPaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
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

async function resolveAuthorizedFile(config: ServerConfig, context: Record<string, unknown>, requested: string, maxBytes = DIRECT_UPLOAD_MAX_BYTES) {
  const roots = allowedRoots(config);
  if (!roots.length) throw new ApiError(400, "invalid_payload", "No authorized workspace roots are available.");
  const realRoots: string[] = [];
  for (const root of roots) {
    try {
      pushUniqueResolvedPath(realRoots, await realpath(root));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  const candidates = isAbsolute(requested)
    ? [resolve(requested)]
    : searchRoots(config, context, roots).map((root) => resolve(root, requested));
  for (const candidate of candidates) {
    if (!roots.some((root) => isWithinRoot(candidate, root))) continue;
    try {
      const realCandidate = await realpath(candidate);
      if (!realRoots.some((root) => isWithinRoot(realCandidate, root))) continue;
      const info = await stat(realCandidate);
      if (!info.isFile()) continue;
      if (info.size < 1 || info.size > maxBytes) {
        throw new ApiError(413, "file_too_large", `Uploads support non-empty files up to ${maxBytes} bytes.`, {
          size: info.size,
          maxBytes,
        });
      }
      return realCandidate;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      throw error;
    }
  }
  throw new ApiError(404, "file_not_found", "File was not found inside an authorized workspace root.", { path: requested });
}

function mimeTypeForPath(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
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

async function cloudUploadEndpoint(config: ServerConfig, suffix: string, dependencies: CloudUploadDependencies) {
  const cloud = await (dependencies.readCloudMcp ?? readConnectCloudMcp)(config);
  const endpoint = readString(cloud, "url");
  const headers = isRecord(cloud?.headers) ? cloud.headers : null;
  const authorization = headers && typeof headers.Authorization === "string"
    ? headers.Authorization
    : headers && typeof headers.authorization === "string"
      ? headers.authorization
      : "";
  if (!endpoint || !authorization) {
    throw new ApiError(409, "cloud_not_connected", "OpenWork Cloud must be connected before uploading files.");
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

function assertGmailUploadActive(signal?: AbortSignal) {
  if (signal?.aborted) throw new ApiError(499, "gmail_attachment_cancelled", "Gmail attachment upload cancelled before dispatch.");
}

async function appendWorkspaceFiles(
  form: FormData,
  config: ServerConfig,
  context: Record<string, unknown>,
  requestedPaths: string[],
  signal?: AbortSignal,
) {
  let totalBytes = 0;
  for (const requested of requestedPaths) {
    assertGmailUploadActive(signal);
    const path = await resolveAuthorizedFile(config, context, requested);
    const bytes = await readFile(path);
    assertGmailUploadActive(signal);
    totalBytes += bytes.byteLength;
    if (totalBytes > DIRECT_UPLOAD_MAX_BYTES) {
      throw new ApiError(413, "files_too_large", `Direct uploads support ${DIRECT_UPLOAD_MAX_BYTES} bytes per request.`);
    }
    const filename = basename(path);
    form.append("file", new File([bytes], filename, { type: mimeTypeForPath(filename) }));
  }
}

async function postDirectUpload(
  config: ServerConfig,
  suffix: string,
  form: FormData,
  dependencies: CloudUploadDependencies,
  signal?: AbortSignal,
) {
  assertGmailUploadActive(signal);
  const endpoint = await cloudUploadEndpoint(config, suffix, dependencies);
  // Last check before remote multipart dispatch, including cancellation while
  // reading files or resolving the member's transport credentials.
  assertGmailUploadActive(signal);
  const response = await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
    method: "POST",
    headers: { authorization: endpoint.authorization },
    body: form,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
    throw new ApiError(response.status || 502, "cloud_upload_failed", `OpenWork Cloud could not upload the file: ${message}`, {
      upstreamCode: isRecord(payload) && typeof payload.error === "string" ? payload.error : undefined,
    });
  }
  return payload;
}

async function uploadDriveFile(
  config: ServerConfig,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies,
) {
  const requestedPath = readString(args, "path");
  if (!requestedPath) throw new ApiError(400, "invalid_payload", "path is required.");
  if (args.connectionId !== undefined && (typeof args.connectionId !== "string" || !/^(google-workspace|emc_[A-Za-z0-9]+)$/.test(args.connectionId))) {
    throw new ApiError(400, "invalid_payload", "connectionId must identify a native Google Workspace connection.");
  }
  const folderId = readString(args, "folderId");
  if (folderId && !/^[A-Za-z0-9_-]{1,512}$/.test(folderId)) throw new ApiError(400, "invalid_payload", "folderId is invalid.");
  const path = await resolveAuthorizedFile(config, context, requestedPath, GOOGLE_DRIVE_UPLOAD_MAX_BYTES);
  const info = await stat(path);
  if (info.size > DIRECT_UPLOAD_MAX_BYTES) {
    dependencies.signal?.throwIfAborted();
    const endpoint = await cloudUploadEndpoint(config, "/v1/direct-uploads/google-workspace/drive-upload-sessions", dependencies);
    const name = basename(path);
    const mimeType = mimeTypeForPath(name);
    let response: Response;
    try {
      response = await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
        method: "POST", redirect: "error",
        headers: { authorization: endpoint.authorization, "content-type": "application/json" },
        body: JSON.stringify({ name, size: info.size, mimeType, folderId: folderId || undefined, connectionId: args.connectionId }),
        signal: dependencies.signal ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS)]) : AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(502, "drive_upload_unconfirmed", "OpenWork Cloud did not confirm upload preparation. Do not retry automatically.");
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      // A disabled/unavailable new route leaves small-file multipart uploads intact.
      if (response.status === 404) throw new ApiError(413, "large_upload_unavailable", "This organization currently supports Drive uploads up to 4 MiB. Resumable uploads are not enabled or the server needs an update.");
      throw new ApiError(response.status, "cloud_upload_failed", isRecord(payload) && typeof payload.message === "string" ? payload.message : `OpenWork Cloud returned HTTP ${response.status}.`);
    }
    if (!isRecord(payload) || typeof payload.uploadUrl !== "string" || payload.size !== info.size) throw new ApiError(502, "invalid_upload_session", "OpenWork Cloud returned an invalid upload session.");
    return uploadDriveResumableFile({ path, size: info.size, mimeType, uploadUrl: payload.uploadUrl, fetch: dependencies.fetchImpl ?? externalFetch, signal: dependencies.signal });
  }
  const form = new FormData();
  await appendWorkspaceFiles(form, config, context, [requestedPath], dependencies.signal);
  if (folderId) form.append("folderId", folderId);
  if (typeof args.connectionId === "string") form.append("connectionId", args.connectionId);
  return postDirectUpload(config, "/v1/direct-uploads/google-workspace/drive-files", form, dependencies, dependencies.signal);
}

async function createGmailDraftWithAttachments(
  config: ServerConfig,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies,
) {
  if (args.connectionId !== undefined && (typeof args.connectionId !== "string" || !/^(google-workspace|emc_[A-Za-z0-9]+)$/.test(args.connectionId))) {
    throw new ApiError(400, "invalid_payload", "connectionId must be a native Google Workspace connection namespace.");
  }
  const paths = readPaths(args.paths);
  if (paths.length < 1 || paths.length > 10) {
    throw new ApiError(400, "invalid_payload", "paths must contain between one and ten workspace files.");
  }
  const form = new FormData();
  await appendWorkspaceFiles(form, config, context, paths, dependencies.signal);
  form.append("payload", JSON.stringify({
    to: readString(args, "to"),
    cc: readString(args, "cc") || undefined,
    bcc: readString(args, "bcc") || undefined,
    subject: readString(args, "subject"),
    body: typeof args.body === "string" ? args.body : "",
    threadId: readString(args, "threadId") || undefined,
    connectionId: args.connectionId,
  }));
  return postDirectUpload(config, "/v1/direct-uploads/google-workspace/gmail-drafts", form, dependencies, dependencies.signal);
}

export async function callOpenWorkCloudUploadAction(
  config: ServerConfig,
  action: string,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies = {},
) {
  if (action === "drive_upload_file") return uploadDriveFile(config, args, context, dependencies);
  if (action === "gmail_create_draft_with_attachments") {
    return createGmailDraftWithAttachments(config, args, context, dependencies);
  }
  return null;
}
