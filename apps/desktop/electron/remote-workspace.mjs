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
