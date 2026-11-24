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

export function localArtifactPath(root: string | null | undefined, value: string, homeDir?: string | null): string | null {
  const reference = parseLocalPathReference(value);
  if (!reference) return null;
  return resolveLocalPath(reference, { workspaceRoot: root, homeDir });
}

function isWorkspaceContainedPath(root: string | null | undefined, path: string): boolean {
  const base = root?.trim();
  if (!base) return false;
  const normalize = (value: string) => value
    .replace(/[\\]+/g, "/")
    .replace(/\/+$/, "")
    .replace(/^[A-Za-z]:/, (drive) => drive.toLowerCase());
  const container = normalize(base);
  const candidate = normalize(path);
  if (candidate.split("/").some((segment) => /^\.{1,2}\s*$/.test(segment))) return false;
  if (!container) return candidate.startsWith("/");
  return candidate === container || candidate.startsWith(`${container}/`);
}

export type NativeFileAction = { path: string; action: "open" | "reveal" };

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

export type FileOpenPlan =
  | { kind: "workspace"; target: OpenTarget }
  | { kind: "native"; path: string; action: "open" | "reveal"; reference: LocalPathReference }
  | { kind: "unavailable"; message: string };

export type FileOrigin = "local" | "remote" | "unknown";

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

export function filePathForCopy(target: OpenTarget, context: { origin: FileOrigin; workspaceRoot?: string | null; homeDir?: string | null }): string {
  if (target.resolvedPath) return target.resolvedPath;
  if (context.origin !== "local") return target.value;
  const reference = parseLocalPathReference(target.value);
  if (reference?.anchor === "relative" && target.exists !== true) return target.value;
  return localArtifactPath(context.workspaceRoot, target.value, context.homeDir) ?? target.value;
}

export function unavailableFileMessage(origin: FileOrigin): string {
  return origin === "local"
    ? "OpenWork couldn't find this file on this computer."
    : "This file is on another machine or is no longer available.";
}

export type FileOpenContext = {
  origin: FileOrigin;
  workspaceRoot?: string | null;
  homeDir?: string | null;
  canOpenLocally: boolean;
  reveal?: boolean;
  findInWorkspace?: (target: OpenTarget, options?: { search: boolean }) => Promise<OpenTarget | null>;
  findOnComputer?: (path: string) => Promise<string | null>;
  sessionTargets?: OpenTarget[];
};

function quoted(path: string) {
  return `\u201c${path}\u201d`;
}

export async function planFileOpen(target: OpenTarget, context: FileOpenContext): Promise<FileOpenPlan> {
  if (target.kind !== "file") return { kind: "unavailable", message: "This link is not a file." };
  if (target.exists === true && !context.findInWorkspace) return { kind: "workspace", target };

  const reference = parseLocalPathReference(target.value);
  if (!reference) {
    return { kind: "unavailable", message: `${quoted(target.name || target.value)} is not a file OpenWork can open.` };
  }

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
        if (context.origin !== "local" || !context.findOnComputer) throw error;
      }
    }
    if (context.origin !== "local" || !context.canOpenLocally || !context.findOnComputer) return null;
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
    return notFound;
  }

  if (context.findOnComputer || pinned || !context.canOpenLocally || context.origin !== "local") return notFound;
  if (reference.anchor === "relative" && context.findInWorkspace) return notFound;

  const native = nativeFileAction(context.workspaceRoot, reference.path, { reveal: context.reveal, homeDir });
  if (!native) return notFound;
  return { kind: "native", path: native.path, action: native.action, reference };
}
