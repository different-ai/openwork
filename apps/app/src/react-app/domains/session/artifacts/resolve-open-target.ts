import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import {
  localPathName,
  parseLocalPathReference,
  resolveLocalPath,
  workspaceLookupValue,
  type LocalPathReference,
} from "./local-path";
import { classifyOpenTarget, isOpenableFileTarget, openTargetFromUrl, type OpenTarget } from "./open-target";

/** A file target for a path written in chat, cleaned up by the shared path reader. */
export function openTargetFromLocalPath(
  value: string,
  options: { decode?: boolean; confidence?: number; reason?: string } = {},
): OpenTarget | null {
  const reference = parseLocalPathReference(value, { decode: options.decode });
  if (!reference) return null;
  return {
    id: `file:${reference.path}`,
    kind: "file",
    value: reference.path,
    name: localPathName(reference.path),
    preview: classifyOpenTarget(reference.path, "file"),
    confidence: options.confidence ?? 100,
    reason: options.reason ?? "explicit link",
  };
}

export function openTargetForHref(href: string, targets: OpenTarget[], root?: string): OpenTarget | null {
  const url = openTargetFromUrl(href);
  if (url) return url;
  if (!href.trim() || href.trim().startsWith("#")) return null;
  const target = openTargetFromLocalPath(href, { decode: true });
  if (!target) return null;
  const path = localArtifactPath(root, target.value);
  const exact = targets.find((candidate) => candidate.kind === "file"
    && (candidate.value === target.value || (path !== null && localArtifactPath(root, candidate.value) === path)));
  return exact ?? target;
}

type ArtifactTargetResolver = Pick<OpenworkServerClient, "resolveArtifacts">;

export function isWorkspaceContainedArtifactTarget(target: OpenTarget) {
  if (!isOpenableFileTarget(target)) return false;

  const normalized = target.value.trim().replace(/[\\]+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;

  return normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * The absolute local path an explicit native open may use, never a URL or a
 * network share. `~/` expands only when the home folder is known.
 */
export function localArtifactPath(root: string | null | undefined, value: string, homeDir?: string | null): string | null {
  const reference = parseLocalPathReference(value);
  if (!reference) return null;
  return resolveLocalPath(reference, { workspaceRoot: root, homeDir });
}

/** Compare locations only; the literal path handed to the desktop is never rewritten. */
function isWorkspaceContainedPath(root: string | null | undefined, path: string): boolean {
  const base = root?.trim();
  if (!base) return false;
  const normalize = (value: string) => value
    .replace(/[\\]+/g, "/")
    .replace(/\/+$/, "")
    .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const container = normalize(base);
  const candidate = normalize(path);
  // A dot segment can leave the workspace after the prefix matches; never treat it as inside.
  if (candidate.split("/").some((segment) => /^\.{1,2}\s*$/.test(segment))) return false;
  if (!container) return candidate.startsWith("/");
  return candidate === container || candidate.startsWith(`${container}/`);
}

export type NativeFileAction = { path: string; action: "open" | "reveal" };

/**
 * Decide what an explicit native action may do with a referenced path. Only files inside
 * the workspace are handed to their default application. Anything else is shown in the
 * file manager and never launched, so a referenced path cannot start a program.
 *
 * This is a string-level pre-check for menu affordances. The desktop process makes the
 * final decision on disk (`__openWorkspaceFile` / `__openWithApp`): it resolves symlinks
 * for both the workspace root and the file and launches only a real file that stays inside
 * the real workspace, revealing anything else instead.
 */
export function nativeFileAction(
  root: string | null | undefined,
  value: string,
  options?: { reveal?: boolean; homeDir?: string | null },
): NativeFileAction | null {
  const path = localArtifactPath(root, value, options?.homeDir);
  if (!path) return null;
  if (options?.reveal || !isWorkspaceContainedPath(root, path)) return { path, action: "reveal" };
  return { path, action: "open" };
}

export async function resolveCollectibleOpenTarget(
  client: ArtifactTargetResolver,
  workspaceId: string,
  target: OpenTarget,
  sessionId?: string | null,
  options?: { search?: boolean },
): Promise<OpenTarget | null> {
  if (target.kind !== "file") return null;

  const response = await client.resolveArtifacts(workspaceId, [target], {
    sessionId: sessionId ?? undefined,
    search: options?.search,
  });
  return response.items.find(isWorkspaceContainedArtifactTarget) ?? null;
}

/** Where a clicked file reference leads. */
export type FileOpenPlan =
  /** The workspace has this file; `target.value` is workspace-relative. */
  | { kind: "workspace"; target: OpenTarget }
  /** A file on this computer outside what the workspace can show; hand it to the desktop. */
  | { kind: "native"; path: string; action: "open" | "reveal"; reference: LocalPathReference }
  /** Nothing to open; say why in words a person understands. */
  | { kind: "unavailable"; message: string };

export type FileOpenContext = {
  workspaceRoot?: string | null;
  homeDir?: string | null;
  /** Can this app hand files to the operating system (desktop)? */
  canOpenLocally: boolean;
  /** Reveal in the file manager instead of opening. */
  reveal?: boolean;
  /**
   * Ask the workspace for the file, searching for it by name when the path
   * does not exist as written. Absent when the workspace is not connected.
   */
  findInWorkspace?: (target: OpenTarget) => Promise<OpenTarget | null>;
};

function quoted(path: string) {
  return `\u201c${path}\u201d`;
}

/**
 * Decide how to open a file reference from chat. Every chat surface (inline
 * code, Markdown links, file chips, tool rows) reaches this one decision:
 *
 * 1. Read the reference once (`~/`, `file://`, quotes, `:line[:col]`).
 * 2. Ask the workspace for it. The server also finds a bare name such as
 *    `computer-control.test.mjs` wherever it lives in the workspace.
 * 3. Otherwise open or reveal a real absolute location on this computer.
 * 4. Otherwise explain that the file could not be found, rather than handing
 *    the desktop a guessed path.
 */
export async function planFileOpen(target: OpenTarget, context: FileOpenContext): Promise<FileOpenPlan> {
  if (target.kind !== "file") return { kind: "unavailable", message: "This link is not a file." };
  if (target.exists === true) return { kind: "workspace", target };

  const reference = parseLocalPathReference(target.value);
  if (!reference) {
    return { kind: "unavailable", message: `${quoted(target.name || target.value)} is not a file OpenWork can open.` };
  }

  const pathContext = { workspaceRoot: context.workspaceRoot, homeDir: context.homeDir };
  const value = workspaceLookupValue(reference, pathContext);
  const lookup: OpenTarget = {
    ...target,
    value,
    name: localPathName(reference.path),
    preview: classifyOpenTarget(reference.path, "file"),
  };

  if (context.findInWorkspace) {
    const found = await context.findInWorkspace(lookup);
    if (found) return { kind: "workspace", target: found };
  }

  const notFound: FileOpenPlan = {
    kind: "unavailable",
    message: `Couldn\u2019t find ${quoted(reference.path)} in this workspace.`,
  };
  if (!context.canOpenLocally) {
    if (context.findInWorkspace) return notFound;
    return { kind: "unavailable", message: "Connect to the workspace to open this file." };
  }
  // The workspace already looked for a relative name and has no such file;
  // joining it to the workspace folder would only name a file that is not there.
  if (reference.anchor === "relative" && context.findInWorkspace) return notFound;

  const native = nativeFileAction(context.workspaceRoot, reference.path, { reveal: context.reveal, homeDir: context.homeDir });
  if (!native) return notFound;
  return { kind: "native", path: native.path, action: native.action, reference };
}
