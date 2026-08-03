import { readFile, realpath, stat } from "node:fs/promises";
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
    description: "Uploads a workspace file up to 4 MiB directly to Google Drive outside model context. OpenWork preserves the file bytes, basename, and source MIME type; it does not convert Office files.",
    inputSchema: {
      type: "object",
      properties: {
        path: workspacePathProperty,
        folderId: { type: "string", description: "Optional Google Drive parent folder id." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    extensionId: OPENWORK_CLOUD_UPLOADS_EXTENSION_ID,
    action: "gmail_create_draft_with_attachments",
    title: "Create a Gmail draft with workspace attachments",
    description: "Creates a reviewable Gmail draft with up to 4 MiB of attachments uploaded directly from authorized workspace paths outside model context. This does not send email.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address." },
        cc: { type: "string", description: "Optional comma-separated Cc recipients." },
        bcc: { type: "string", description: "Optional comma-separated Bcc recipients." },
        subject: { type: "string", description: "Draft subject." },
        body: { type: "string", description: "Plain-text draft body." },
        threadId: { type: "string", description: "Optional Gmail thread id for a reply draft." },
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

async function resolveAuthorizedFile(config: ServerConfig, context: Record<string, unknown>, requested: string) {
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
      if (info.size < 1 || info.size > DIRECT_UPLOAD_MAX_BYTES) {
        throw new ApiError(413, "file_too_large", `Direct uploads support files up to ${DIRECT_UPLOAD_MAX_BYTES} bytes.`, {
          size: info.size,
          maxBytes: DIRECT_UPLOAD_MAX_BYTES,
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

async function appendWorkspaceFiles(
  form: FormData,
  config: ServerConfig,
  context: Record<string, unknown>,
  requestedPaths: string[],
) {
  let totalBytes = 0;
  for (const requested of requestedPaths) {
    const path = await resolveAuthorizedFile(config, context, requested);
    const bytes = await readFile(path);
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
) {
  const endpoint = await cloudUploadEndpoint(config, suffix, dependencies);
  const response = await (dependencies.fetchImpl ?? externalFetch)(endpoint.url.toString(), {
    method: "POST",
    headers: { authorization: endpoint.authorization },
    body: form,
    signal: AbortSignal.timeout(DIRECT_UPLOAD_TIMEOUT_MS),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
    throw new ApiError(response.status || 502, "cloud_upload_failed", `OpenWork Cloud could not upload the file: ${message}`);
  }
  return payload;
}

async function uploadDriveFile(
  config: ServerConfig,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies,
) {
  const path = readString(args, "path");
  if (!path) throw new ApiError(400, "invalid_payload", "path is required.");
  const form = new FormData();
  await appendWorkspaceFiles(form, config, context, [path]);
  const folderId = readString(args, "folderId");
  if (folderId) form.append("folderId", folderId);
  return postDirectUpload(config, "/v1/direct-uploads/google-workspace/drive-files", form, dependencies);
}

async function createGmailDraftWithAttachments(
  config: ServerConfig,
  args: Record<string, unknown>,
  context: Record<string, unknown>,
  dependencies: CloudUploadDependencies,
) {
  const paths = readPaths(args.paths);
  if (paths.length < 1 || paths.length > 10) {
    throw new ApiError(400, "invalid_payload", "paths must contain between one and ten workspace files.");
  }
  const form = new FormData();
  await appendWorkspaceFiles(form, config, context, paths);
  form.append("payload", JSON.stringify({
    to: readString(args, "to"),
    cc: readString(args, "cc") || undefined,
    bcc: readString(args, "bcc") || undefined,
    subject: readString(args, "subject"),
    body: typeof args.body === "string" ? args.body : "",
    threadId: readString(args, "threadId") || undefined,
  }));
  return postDirectUpload(config, "/v1/direct-uploads/google-workspace/gmail-drafts", form, dependencies);
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
