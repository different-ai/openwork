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

function stripOpenworkWorkspaceMount(input) {
  const raw = trim(input);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const workspaceIndex = segments.indexOf("workspace");
    const legacyIndex = segments.indexOf("w");
    const mountIndex = workspaceIndex >= 0 ? workspaceIndex : legacyIndex;
    if (mountIndex >= 0 && segments[mountIndex + 1]) {
      const prefix = segments.slice(0, mountIndex).join("/");
      url.pathname = prefix ? `/${prefix}` : "/";
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return raw.replace(/\/(?:workspace|w)\/[^/?#]+.*$/, "").replace(/\/+$/, "") || raw;
  }
}

export function isDesktopFetchAllowedForWorkspaces(url, workspaces) {
  let parsed;
  try {
    parsed = new URL(trim(url));
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace?.workspaceType !== "remote") continue;
    for (const candidate of [workspace.baseUrl, workspace.openworkHostUrl]) {
      const stripped = stripOpenworkWorkspaceMount(candidate);
      if (!stripped) continue;
      try {
        if (new URL(stripped).origin === parsed.origin) return true;
      } catch {
        // Ignore malformed persisted values; they are not valid fetch targets.
      }
    }
  }
  return false;
}

export function isDesktopFetchAllowedForDenBootstrap(url, bootstrapConfig) {
  let parsed;
  try {
    parsed = new URL(trim(url));
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  for (const candidate of [bootstrapConfig?.baseUrl, bootstrapConfig?.apiBaseUrl]) {
    if (!candidate) continue;
    try {
      if (new URL(trim(candidate)).origin === parsed.origin) return true;
    } catch {
      // Ignore malformed bootstrap values; they are not valid fetch targets.
    }
  }
  return false;
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
      redirect: "manual",
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
 * @param {{ hostUrl: unknown; token?: unknown; directory?: unknown; fetchImpl?: typeof fetch; timeoutMs?: number }} input
 */
export async function discoverOpenworkWorkspace({ hostUrl, token, directory, fetchImpl, timeoutMs }) {
  const list = await fetchOpenworkWorkspaceList(hostUrl, token, { fetchImpl, timeoutMs });
  return selectOpenworkWorkspaceForConnection(list, directory);
}
