import type { OpenworkServerClient } from "@/app/lib/openwork-server";

import {
  localPathName,
  parseLocalPathReference,
  resolveLocalPath,
  workspaceLookupValue,
  type LocalPathReference,
} from "./local-path";
import { classifyOpenTarget, isOpenableFileTarget, openTargetFromUrl, type OpenTarget } from "./open-target";
import { sessionFileCandidate } from "./path-reference-context";

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

export type FileOrigin = "local" | "remote" | "unknown";

/** Origin comes from the session's owning runtime, never from the spelling of a path. */
export function fileOriginForRuntime(input: { desktop: boolean; serverUrl?: string | null; sandboxBackend?: string | null }): FileOrigin {
  if (!input.serverUrl) return "unknown";
  try {
    const host = new URL(input.serverUrl).hostname;
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host);
    const sandboxed = Boolean(input.sandboxBackend && input.sandboxBackend !== "none");
    return input.desktop && loopback && !sandboxed ? "local" : "remote";
  } catch {
    return "unknown";
  }
}

/** Copy a reference in its own machine's namespace, never expand a remote `~/` locally. */
export function filePathForCopy(target: OpenTarget, context: { origin: FileOrigin; workspaceRoot?: string | null; homeDir?: string | null }): string {
  if (target.resolvedPath) return target.resolvedPath;
  if (context.origin !== "local") return target.value;
  return localArtifactPath(context.workspaceRoot, target.value, context.homeDir) ?? target.value;
}

export function unavailableFileMessage(origin: FileOrigin): string {
  return origin === "local"
    ? "OpenWork couldn't find this file on this computer."
    : "This file is on another machine or is no longer available.";
}

export type FileOpenContext = {
  /** Only a session owned by this computer's native runtime may use local file APIs. */
  origin: FileOrigin;
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
  findInWorkspace?: (target: OpenTarget, options?: { search: boolean }) => Promise<OpenTarget | null>;
  /** Read-only existence/canonicalization on this computer; never called for remote origins. */
  findOnComputer?: (path: string) => Promise<string | null>;
  /** File identities from this session's tool calls and verified transcript. */
  sessionTargets?: OpenTarget[];
};

function quoted(path: string) {
  return `\u201c${path}\u201d`;
}

/**
 * Decide how to open a file reference from chat. Every chat surface (inline
 * code, Markdown links, file chips, tool rows) reaches this one decision:
 *
 * 1. Read the reference once (`~/`, `file://`, quotes, `:line[:col]`).
 * 2. Check exact directory-context and session-evidence candidates, followed by
 *    bounded workspace/conversation search for an unresolved relative name.
 * 3. Only for a local-origin session, canonicalize/check candidates on this
 *    computer. The desktop rechecks before opening/revealing the selected item.
 * 4. Otherwise give a calm unavailable/other-machine result for the caller's
 *    copy-path fallback, never hand the desktop a guessed or remote path.
 */
export async function planFileOpen(target: OpenTarget, context: FileOpenContext): Promise<FileOpenPlan> {
  if (target.kind !== "file") return { kind: "unavailable", message: "This link is not a file." };
  // Transcript verification is a snapshot, not a promise the file still exists.
  if (target.exists === true && !context.findInWorkspace) return { kind: "workspace", target };

  const reference = parseLocalPathReference(target.value);
  if (!reference) {
    return { kind: "unavailable", message: `${quoted(target.name || target.value)} is not a file OpenWork can open.` };
  }

  // A remote `~/` belongs to that runtime's account, not this computer's user.
  const homeDir = context.origin === "local" ? context.homeDir : null;
  const pathContext = { workspaceRoot: context.workspaceRoot, homeDir };
  const value = workspaceLookupValue(reference, pathContext);
  const lookup: OpenTarget = {
    ...target,
    value,
    name: localPathName(reference.path),
    preview: classifyOpenTarget(reference.path, "file"),
  };

  const notFound: FileOpenPlan = { kind: "unavailable", message: unavailableFileMessage(context.origin) };
  const pinned = Boolean(target.fileScope || target.resolvedPath || target.exists);
  const candidates: OpenTarget[] = [];
  if (!pinned && reference.anchor === "relative") {
    for (const hint of (target.pathHints ?? []).slice(0, 8)) {
      const candidate = openTargetFromLocalPath(hint);
      if (candidate && candidate.value !== target.value) candidates.push(candidate);
    }
    const evidence = sessionFileCandidate(reference, context.sessionTargets ?? []);
    // The written directory is strongest evidence. Then try the written path,
    // then a unique session identity; only afterwards do a bounded name search.
    if (candidates.length || evidence) candidates.push(lookup);
    if (evidence) candidates.push(evidence);
  }
  const find = async (candidate: OpenTarget, search: boolean): Promise<FileOpenPlan | null> => {
    const parsed = parseLocalPathReference(candidate.resolvedPath ?? candidate.value);
    if (!parsed) return null;
    const candidateLookup = candidate.fileScope ? candidate : { ...candidate, value: workspaceLookupValue(parsed, pathContext) };
    if (context.findInWorkspace) {
      try {
        const found = await context.findInWorkspace(candidateLookup, { search });
        if (found) return { kind: "workspace", target: found };
      } catch (error) {
        // A local server outage doesn't make an existing local file disappear.
        // Remote and unknown origins must still stop without probing this disk.
        if (context.origin !== "local" || !context.findOnComputer) throw error;
      }
    }
    if (context.origin !== "local" || !context.canOpenLocally || !context.findOnComputer) return null;
    // A conversation-relative identity cannot be reconstructed from the workspace
    // root. If its owning resolver misses, only an exact known absolute path can
    // be probed; never accidentally open a same-named workspace file.
    if (candidate.fileScope === "conversation" && !candidate.resolvedPath) return null;
    const absolute = resolveLocalPath(parsed, pathContext);
    if (!absolute) return null;
    const verified = await context.findOnComputer(absolute);
    if (!verified) return null;
    const native = nativeFileAction(context.workspaceRoot, verified, { reveal: context.reveal, homeDir });
    return native ? { kind: "native", ...native, reference: parsed } : null;
  };
  try {
    for (const candidate of candidates) {
      const found = await find(candidate, false);
      if (found) return found;
    }
    const found = await find(lookup, !pinned);
    if (found) return found;
  } catch {
    // An offline/expired connection isn't evidence that another file is the one
    // the person meant. In particular, never fall through to local disk remotely.
    return notFound;
  }

  if (context.findOnComputer || pinned || !context.canOpenLocally || context.origin !== "local") return notFound;
  // The workspace already looked for a relative name and has no such file;
  // joining it to the workspace folder would only name a file that is not there.
  if (reference.anchor === "relative" && context.findInWorkspace) return notFound;

  const native = nativeFileAction(context.workspaceRoot, reference.path, { reveal: context.reveal, homeDir });
  if (!native) return notFound;
  return { kind: "native", path: native.path, action: native.action, reference };
}
