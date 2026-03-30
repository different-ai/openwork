import type { WorkspaceDisplay } from "../types";
import { parseOpenworkWorkspaceIdFromUrl } from "../lib/openwork-server";
import type { WorkspaceInfo } from "../lib/tauri";
import type { BundleImportTarget, BundleV1 } from "./types";

export function buildImportPayloadFromBundle(bundle: BundleV1): {
  payload: Record<string, unknown>;
  importedSkillsCount: number;
} {
  if (bundle.type === "skill") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: [
          {
            name: bundle.name,
            description: bundle.description,
            trigger: bundle.trigger,
            content: bundle.content,
          },
        ],
      },
      importedSkillsCount: 1,
    };
  }

  if (bundle.type === "skills-set") {
    return {
      payload: {
        mode: { skills: "merge" },
        skills: bundle.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          trigger: skill.trigger,
          content: skill.content,
        })),
      },
      importedSkillsCount: bundle.skills.length,
    };
  }

  const workspace = bundle.workspace;
  const payload: Record<string, unknown> = {
    mode: {
      opencode: "merge",
      openwork: "merge",
      skills: "merge",
      commands: "merge",
      files: "merge",
    },
  };

  if (workspace.opencode && typeof workspace.opencode === "object") {
    payload.opencode = workspace.opencode;
  }
  if (workspace.openwork && typeof workspace.openwork === "object") {
    payload.openwork = workspace.openwork;
  }
  if (Array.isArray(workspace.skills) && workspace.skills.length > 0) {
    payload.skills = workspace.skills;
  }
  if (Array.isArray(workspace.commands) && workspace.commands.length > 0) {
    payload.commands = workspace.commands;
  }
  if (Array.isArray(workspace.files) && workspace.files.length > 0) {
    payload.files = workspace.files;
  }

  return {
    payload,
    importedSkillsCount: Array.isArray(workspace.skills) ? workspace.skills.length : 0,
  };
}

export function isBundleImportWorkspace(workspace: WorkspaceDisplay | WorkspaceInfo | null): boolean {
  if (!workspace?.id?.trim()) return false;
  if (workspace.workspaceType === "local") {
    return Boolean(workspace.path?.trim());
  }
  return Boolean(workspace.remoteType === "openwork" || workspace.openworkHostUrl?.trim() || workspace.openworkWorkspaceId?.trim());
}

export function resolveBundleImportTargetForWorkspace(
  workspace: WorkspaceDisplay | WorkspaceInfo | null,
): BundleImportTarget | undefined {
  if (!workspace) return undefined;
  if (workspace.workspaceType === "local") {
    const localRoot = workspace.path?.trim() ?? "";
    return localRoot ? { localRoot } : undefined;
  }

  const workspaceId =
    workspace.openworkWorkspaceId?.trim() ||
    parseOpenworkWorkspaceIdFromUrl(workspace.openworkHostUrl ?? "") ||
    parseOpenworkWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
    null;
  const directoryHint = workspace.directory?.trim() || workspace.path?.trim() || null;
  if (workspaceId || directoryHint) {
    return {
      workspaceId,
      directoryHint,
    };
  }
  return undefined;
}

export function describeWorkspaceForBundleToasts(workspace: WorkspaceDisplay | WorkspaceInfo | null): string {
  return (
    workspace?.displayName?.trim() ||
    workspace?.openworkWorkspaceName?.trim() ||
    workspace?.name?.trim() ||
    workspace?.directory?.trim() ||
    workspace?.path?.trim() ||
    workspace?.baseUrl?.trim() ||
    "the selected worker"
  );
}
