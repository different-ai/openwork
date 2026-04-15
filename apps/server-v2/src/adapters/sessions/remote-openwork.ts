import { RouteError } from "../../http.js";
import type { ServerRecord, WorkspaceRecord } from "../../database/types.js";
import { createOpenCodeSessionBackend } from "./opencode-backend.js";

function encodeBasicAuth(username: string, password: string) {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function pickString(record: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function buildRemoteHeaders(server: ServerRecord) {
  const auth = server.auth && typeof server.auth === "object" ? server.auth as Record<string, unknown> : null;
  const headers: Record<string, string> = {};
  const bearer = pickString(auth, ["openworkClientToken", "openworkToken", "authToken", "token", "bearerToken"]);
  const hostToken = pickString(auth, ["openworkHostToken", "hostToken"]);
  const username = pickString(auth, ["username", "user"]);
  const password = pickString(auth, ["password", "pass"]);

  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  } else if (username && password) {
    headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
  }

  if (hostToken) {
    headers["X-OpenWork-Host-Token"] = hostToken;
  }

  return headers;
}

export function createRemoteOpenworkSessionAdapter(input: {
  server: ServerRecord;
  workspace: WorkspaceRecord;
}) {
  if (!input.server.baseUrl) {
    throw new RouteError(502, "bad_gateway", "Remote workspace server is missing a base URL.");
  }

  const remoteType = input.workspace.notes?.remoteType === "opencode" ? "opencode" : "openwork";
  const remoteWorkspaceId = input.workspace.remoteWorkspaceId?.trim() ?? "";

  if (remoteType === "openwork") {
    if (!remoteWorkspaceId) {
      throw new RouteError(502, "bad_gateway", "Remote OpenWork workspace is missing its remote workspace identifier.");
    }

    return createOpenCodeSessionBackend({
      baseUrl: `${input.server.baseUrl.replace(/\/+$/, "")}/w/${encodeURIComponent(remoteWorkspaceId)}/opencode`,
      headers: buildRemoteHeaders(input.server),
    });
  }

  return createOpenCodeSessionBackend({
    baseUrl: input.server.baseUrl,
    directory: typeof input.workspace.notes?.directory === "string" ? input.workspace.notes.directory : undefined,
    headers: buildRemoteHeaders(input.server),
  });
}
