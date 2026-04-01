import type { OpenworkWorkspaceInfo } from "../lib/openwork-server";
import { normalizeDirectoryPath } from "../utils";

type OpenworkWorkspaceSelectionReason = "missing" | "not-found" | "ambiguous";

export type OpenworkWorkspaceSelectionResult =
  | {
      ok: true;
      workspace: OpenworkWorkspaceInfo;
    }
  | {
      ok: false;
      reason: OpenworkWorkspaceSelectionReason;
      message: string;
    };

const workspaceDirectory = (entry: OpenworkWorkspaceInfo) =>
  normalizeDirectoryPath((entry.opencode?.directory as string | undefined) ?? entry.directory ?? entry.path ?? "");

export function selectOpenworkWorkspace(input: {
  items: OpenworkWorkspaceInfo[];
  workspaceId?: string | null;
  directoryHint?: string | null;
}): OpenworkWorkspaceSelectionResult {
  const items = Array.isArray(input.items) ? input.items.filter((entry): entry is OpenworkWorkspaceInfo => Boolean(entry?.id)) : [];
  const explicitWorkspaceId = input.workspaceId?.trim() ?? "";
  const directoryHint = normalizeDirectoryPath(input.directoryHint ?? "");

  if (!items.length) {
    return {
      ok: false,
      reason: "missing",
      message: "OpenWork server did not return a worker.",
    };
  }

  if (explicitWorkspaceId) {
    const exact = items.find((entry) => entry.id === explicitWorkspaceId);
    if (exact) {
      return { ok: true, workspace: exact };
    }
    return {
      ok: false,
      reason: "not-found",
      message: "OpenWork worker not found on that host.",
    };
  }

  if (directoryHint) {
    const matches = items.filter((entry) => workspaceDirectory(entry) === directoryHint);
    if (matches.length === 1) {
      return { ok: true, workspace: matches[0] };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: "ambiguous",
        message: "OpenWork host returned multiple workspaces for that directory.",
      };
    }
    if (items.length === 1) {
      return { ok: true, workspace: items[0] };
    }
    return {
      ok: false,
      reason: "not-found",
      message: "OpenWork worker directory not found on that host.",
    };
  }

  if (items.length === 1) {
    return { ok: true, workspace: items[0] };
  }

  return {
    ok: false,
    reason: "ambiguous",
    message: "OpenWork host returned multiple workspaces. Use a workspace-scoped URL (/w/ws_*) or reconnect from the specific workspace.",
  };
}
