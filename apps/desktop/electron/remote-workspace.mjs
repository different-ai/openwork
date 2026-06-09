function trim(value) {
  return String(value ?? "").trim();
}

function normalizeRemoteDirectory(value) {
  const normalized = trim(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "";
}

function workspaceDirectoryCandidates(workspace) {
  if (!workspace || typeof workspace !== "object") return [];
  return [
    workspace.directory,
    workspace.path,
    workspace.opencode?.directory,
  ]
    .map(normalizeRemoteDirectory)
    .filter(Boolean);
}

export function selectOpenworkWorkspaceForConnection(list, directory) {
  const items = Array.isArray(list?.items)
    ? list.items
    : Array.isArray(list?.workspaces)
      ? list.workspaces
      : [];
  if (!items.length) return null;

  const expectedDirectory = normalizeRemoteDirectory(directory);
  if (expectedDirectory) {
    return items.find((item) => workspaceDirectoryCandidates(item).includes(expectedDirectory)) ?? null;
  }

  const activeId = trim(list?.activeId);
  return (activeId ? items.find((item) => trim(item?.id) === activeId) : null) ?? items[0] ?? null;
}

export function openworkWorkspaceDisplayName(workspace) {
  return (
    trim(workspace?.displayName) ||
    trim(workspace?.openworkWorkspaceName) ||
    trim(workspace?.name) ||
    trim(workspace?.id) ||
    null
  );
}

/**
 * Build headers for the normal `/workspaces` client-discovery path.
 * Host tokens are intentionally excluded; they are valid only for explicit
 * host-only routes such as `/env/*`.
 *
 * @param {unknown} token
 */
export function openworkWorkspaceDiscoveryHeaders(token) {
  const headers = new Headers();
  const bearerToken = trim(token);
  if (bearerToken) headers.set("Authorization", `Bearer ${bearerToken}`);
  return headers;
}

/**
 * @param {unknown} hostUrl
 * @param {unknown} token
 * @param {{ fetchImpl?: typeof fetch; timeoutMs?: number }} [options]
 */
export async function fetchOpenworkWorkspaceList(hostUrl, token, options = {}) {
  const url = `${String(hostUrl ?? "").replace(/\/+$/, "")}/workspaces`;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.max(1, Math.floor(Number(options.timeoutMs)))
    : 8_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;

  try {
    const response = await fetchImpl(url, {
      headers: openworkWorkspaceDiscoveryHeaders(token),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`OpenWork workspace discovery failed (${response.status} ${response.statusText || "HTTP error"})`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @param {{ hostUrl: unknown; token?: unknown; directory?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number; hostToken?: unknown }} input
 */
export async function discoverOpenworkWorkspace({ hostUrl, token, directory, fetchImpl, timeoutMs, hostToken: _hostToken }) {
  const list = await fetchOpenworkWorkspaceList(hostUrl, token, { fetchImpl, timeoutMs });
  return selectOpenworkWorkspaceForConnection(list, directory);
}
