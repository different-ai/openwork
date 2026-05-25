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
