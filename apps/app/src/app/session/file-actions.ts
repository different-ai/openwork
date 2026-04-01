import { join } from "@tauri-apps/api/path";
import { normalizeLocalFilePath } from "../lib/local-file-path";
import { desktopGetDefaultAppForFile, type DesktopFileAssociation } from "../lib/tauri";
import { isTauriRuntime } from "../utils";

export type LocalFileActionMode = "open" | "reveal";

export type LocalFileActionResult =
  | { ok: true; path: string }
  | { ok: false; reason: "missing-root" | string };

export const isAbsoluteLocalPath = (value: string) =>
  /^(?:[a-zA-Z]:[\\/]|\\\\|\/|~\/)/.test(value.trim());

export const resolveLocalFileCandidates = async (file: string, workspaceRoot: string) => {
  const trimmed = normalizeLocalFilePath(file).trim();
  if (!trimmed) return [];
  if (isAbsoluteLocalPath(trimmed)) return [trimmed];

  const root = workspaceRoot.trim();
  if (!root) return [];

  const normalized = trimmed
    .replace(/[\\/]+/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (value: string) => {
    const key = value
      .trim()
      .replace(/[\\/]+/g, "/")
      .toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };

  pushCandidate(await join(root, normalized));

  if (normalized.startsWith(".opencode/openwork/outbox/")) {
    return candidates;
  }

  if (normalized.startsWith("openwork/outbox/")) {
    const suffix = normalized.slice("openwork/outbox/".length);
    if (suffix) {
      pushCandidate(await join(root, ".opencode", "openwork", "outbox", suffix));
    }
    return candidates;
  }

  if (normalized.startsWith("outbox/")) {
    const suffix = normalized.slice("outbox/".length);
    if (suffix) {
      pushCandidate(await join(root, ".opencode", "openwork", "outbox", suffix));
    }
    return candidates;
  }

  if (!normalized.startsWith(".opencode/")) {
    pushCandidate(await join(root, ".opencode", "openwork", "outbox", normalized));
  }

  return candidates;
};

export const runLocalFileAction = async (options: {
  file: string;
  workspaceRoot: string;
  action: (candidate: string) => Promise<void>;
}): Promise<LocalFileActionResult> => {
  const candidates = await resolveLocalFileCandidates(options.file, options.workspaceRoot);
  if (!candidates.length) {
    return { ok: false, reason: "missing-root" };
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      await options.action(candidate);
      return { ok: true, path: candidate };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    reason: lastError instanceof Error ? lastError.message : "File action failed",
  };
};

export const resolvePrimaryLocalFile = async (file: string, workspaceRoot: string) => {
  const candidates = await resolveLocalFileCandidates(file, workspaceRoot);
  return candidates[0] ?? null;
};

export const getDefaultDesktopFileAssociation = async (
  file: string,
  workspaceRoot: string,
): Promise<DesktopFileAssociation | null> => {
  if (!isTauriRuntime()) return null;
  const resolved = await resolvePrimaryLocalFile(file, workspaceRoot);
  if (!resolved) return null;
  return desktopGetDefaultAppForFile(resolved);
};
