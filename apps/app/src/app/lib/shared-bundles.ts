import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { DEFAULT_DEN_BASE_URL, normalizeDenBaseUrl } from "./den";
import {
  normalizeOpenworkServerUrl,
  type OpenworkServerClient,
  type OpenworkWorkspaceExport,
} from "./openwork-server";
import type { WorkspacePreset } from "../types";
import { isTauriRuntime, safeStringify } from "../utils";

export type RemoteWorkspaceDefaults = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  autoConnect?: boolean;
};

type SharedSkillItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

export type SharedSkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

export type SharedSkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description?: string;
  skills: SharedSkillItem[];
};

export type SharedWorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description?: string;
  workspace: OpenworkWorkspaceExport;
};

export type SharedBundleV1 =
  | SharedSkillBundleV1
  | SharedSkillsSetBundleV1
  | SharedWorkspaceProfileBundleV1;

export type SharedBundleImportIntent = "new_worker" | "import_current";

export type SharedBundleDeepLink = {
  bundleUrl: string;
  intent: SharedBundleImportIntent;
  source?: string;
  orgId?: string;
  label?: string;
};

export type DenAuthDeepLink = {
  grant: string;
  denBaseUrl: string;
};

export function normalizeSharedBundleImportIntent(value: string | null | undefined): SharedBundleImportIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return (
    normalized === "openwork:" ||
    normalized === "openwork-dev:" ||
    normalized === "https:" ||
    normalized === "http:"
  );
}

export function describeSharedBundleImport(bundle: SharedBundleV1): {
  title: string;
  description: string;
  items: string[];
} {
  if (bundle.type === "skill") {
    return {
      title: "Import 1 skill",
      description: bundle.description?.trim() || `Add \`${bundle.name}\` to an existing worker or create a new one for it.`,
      items: [bundle.name],
    };
  }

  if (bundle.type === "skills-set") {
    const count = bundle.skills.length;
    return {
      title: `Import ${count} skill${count === 1 ? "" : "s"}`,
      description:
        bundle.description?.trim() ||
        `${bundle.name || "Shared skills"} is ready to import into an existing worker or a new worker.`,
      items: bundle.skills.map((skill) => skill.name),
    };
  }

  return {
    title: bundle.name?.trim() || "Open workspace template",
    description:
      bundle.description?.trim() ||
      `${bundle.name || "This shared workspace template"} is ready to start in a new worker or import into an existing one.`,
    items: Array.isArray(bundle.workspace.skills) ? bundle.workspace.skills.map((skill) => skill.name) : [],
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSkillItem(value: unknown): SharedSkillItem | null {
  const record = readRecord(value);
  if (!record) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!name || !content) return null;
  return {
    name,
    description: typeof record.description === "string" ? record.description : undefined,
    trigger: typeof record.trigger === "string" ? record.trigger : undefined,
    content,
  };
}

function readTemplateFileItem(value: unknown): { path: string; content: string } | null {
  const record = readRecord(value);
  if (!record) return null;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  const content = typeof record.content === "string" ? record.content : "";
  if (!path) return null;
  return { path, content };
}

function readWorkspacePreset(value: unknown): WorkspacePreset {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "automation" || normalized === "minimal") {
    return normalized;
  }
  return "starter";
}

export function defaultPresetFromTemplateBundle(bundle: SharedWorkspaceProfileBundleV1): WorkspacePreset {
  const openwork = bundle.workspace?.openwork;
  if (!openwork || typeof openwork !== "object") return "starter";
  const workspace = (openwork as Record<string, unknown>).workspace;
  if (!workspace || typeof workspace !== "object") return "starter";
  return readWorkspacePreset((workspace as Record<string, unknown>).preset);
}

export function parseSharedBundle(value: unknown): SharedBundleV1 {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Invalid shared bundle payload.");
  }

  const schemaVersion = typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  const type = typeof record.type === "string" ? record.type.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";

  if (schemaVersion !== 1) {
    throw new Error("Unsupported bundle schema version.");
  }

  if (type === "skill") {
    const content = typeof record.content === "string" ? record.content : "";
    if (!name || !content) {
      throw new Error("Invalid skill bundle payload.");
    }
    return {
      schemaVersion: 1,
      type: "skill",
      name,
      description: typeof record.description === "string" ? record.description : undefined,
      trigger: typeof record.trigger === "string" ? record.trigger : undefined,
      content,
    };
  }

  if (type === "skills-set") {
    const skills = Array.isArray(record.skills)
      ? record.skills.map(readSkillItem).filter((item): item is SharedSkillItem => Boolean(item))
      : [];
    if (!skills.length) {
      throw new Error("Skills set bundle has no importable skills.");
    }
    return {
      schemaVersion: 1,
      type: "skills-set",
      name: name || "Shared skills",
      description: typeof record.description === "string" ? record.description : undefined,
      skills,
    };
  }

  if (type === "workspace-profile") {
    const workspace = readRecord(record.workspace);
    if (!workspace) {
      throw new Error("Workspace profile bundle is missing workspace payload.");
    }
    const files = Array.isArray(workspace.files)
      ? workspace.files.map(readTemplateFileItem).filter((item): item is { path: string; content: string } => Boolean(item))
      : [];
    return {
      schemaVersion: 1,
      type: "workspace-profile",
      name: name || "Shared workspace profile",
      description: typeof record.description === "string" ? record.description : undefined,
      workspace: {
        ...(workspace as OpenworkWorkspaceExport),
        ...(files.length ? { files } : {}),
      },
    };
  }

  throw new Error(`Unsupported bundle type: ${type || "unknown"}`);
}

export async function fetchSharedBundle(
  bundleUrl: string,
  serverClient?: OpenworkServerClient | null,
): Promise<SharedBundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid shared bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Shared bundle URL must use http(s).");
  }

  const segments = targetUrl.pathname.split("/").filter(Boolean);
  if (segments[0] === "b" && segments[1] && segments.length === 2) {
    targetUrl.pathname = `/b/${segments[1]}/data`;
    targetUrl.searchParams.delete("format");
  } else if (segments[0] === "b" && segments[1] && segments[2] === "data") {
    targetUrl.searchParams.delete("format");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  if (serverClient) {
    return parseSharedBundle(await serverClient.fetchBundle(targetUrl.toString()));
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = isTauriRuntime()
        ? await tauriFetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          })
        : await fetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      throw new Error(`Failed to load shared bundle from ${targetUrl.toString()}: ${message}`);
    }
    if (!response.ok) {
      const details = (await response.text()).trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to fetch bundle from ${targetUrl.toString()} (${response.status})${suffix}`);
    }
    return parseSharedBundle(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}

export function buildImportPayloadFromBundle(bundle: SharedBundleV1): {
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
    },
  };
  if (workspace.opencode && typeof workspace.opencode === "object") payload.opencode = workspace.opencode;
  if (workspace.openwork && typeof workspace.openwork === "object") payload.openwork = workspace.openwork;
  if (Array.isArray(workspace.skills) && workspace.skills.length) payload.skills = workspace.skills;
  if (Array.isArray(workspace.commands) && workspace.commands.length) payload.commands = workspace.commands;
  if (Array.isArray(workspace.files) && workspace.files.length) payload.files = workspace.files;

  const importedSkillsCount = Array.isArray(workspace.skills) ? workspace.skills.length : 0;
  return { payload, importedSkillsCount };
}

export function parseSharedBundleDeepLink(rawUrl: string): SharedBundleDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  const looksLikeImportRoute =
    routeHost === "import-bundle" ||
    routePath === "import-bundle" ||
    routeTail === "import-bundle";

  const rawBundleUrl =
    url.searchParams.get("ow_bundle") ??
    url.searchParams.get("bundleUrl") ??
    "";

  if (!looksLikeImportRoute && !rawBundleUrl.trim()) {
    return null;
  }

  try {
    if ((protocol === "https:" || protocol === "http:") && !rawBundleUrl.trim()) {
      const host = url.hostname.toLowerCase();
      const path = url.pathname.replace(/^\/+/, "");
      const segments = path.split("/").filter(Boolean);
      if (
        (host === "share.openworklabs.com"
          || host.endsWith(".openworklabs.com")
          || host === "share.openwork.software"
          || host.endsWith(".openwork.software"))
        && segments[0] === "b"
        && segments[1]
      ) {
        const intent = normalizeSharedBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"));
        const source = url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? "";
        const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
        const label = url.searchParams.get("ow_label")?.trim() ?? url.searchParams.get("label")?.trim() ?? "";
        return {
          bundleUrl: url.toString(),
          intent,
          source: source || undefined,
          orgId: orgId || undefined,
          label: label || undefined,
        };
      }
    }

    const parsedBundleUrl = new URL(rawBundleUrl.trim());
    if (parsedBundleUrl.protocol !== "https:" && parsedBundleUrl.protocol !== "http:") {
      return null;
    }
    const intent = normalizeSharedBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent"));
    const source = url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? "";
    const orgId = url.searchParams.get("ow_org")?.trim() ?? "";
    const label = url.searchParams.get("ow_label")?.trim() ?? url.searchParams.get("label")?.trim() ?? "";
    return {
      bundleUrl: parsedBundleUrl.toString(),
      intent,
      source: source || undefined,
      orgId: orgId || undefined,
      label: label || undefined,
    };
  } catch {
    return null;
  }
}

export function stripSharedBundleQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of ["ow_bundle", "bundleUrl", "ow_intent", "intent", "ow_source", "source", "ow_org", "ow_label"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export function parseRemoteConnectDeepLink(rawUrl: string): RemoteWorkspaceDefaults | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "connect-remote" && routePath !== "connect-remote" && routeTail !== "connect-remote") {
    return null;
  }

  const hostUrlRaw = url.searchParams.get("openworkHostUrl") ?? url.searchParams.get("openworkUrl") ?? "";
  const tokenRaw = url.searchParams.get("openworkToken") ?? url.searchParams.get("accessToken") ?? "";
  const normalizedHostUrl = normalizeOpenworkServerUrl(hostUrlRaw);
  const token = tokenRaw.trim();
  if (!normalizedHostUrl || !token) {
    return null;
  }

  const workerName = url.searchParams.get("workerName")?.trim() ?? "";
  const workerId = url.searchParams.get("workerId")?.trim() ?? "";
  const displayName = workerName || (workerId ? `Worker ${workerId.slice(0, 8)}` : "");
  const autoConnectRaw =
    url.searchParams.get("autoConnect") ??
    url.searchParams.get("bypassModal") ??
    url.searchParams.get("bypassAddWorkerModal") ??
    "";
  const autoConnect = ["1", "true", "yes", "on"].includes(autoConnectRaw.trim().toLowerCase());

  return {
    openworkHostUrl: normalizedHostUrl,
    openworkToken: token,
    directory: null,
    displayName: displayName || null,
    autoConnect,
  };
}

export function parseDenAuthDeepLink(rawUrl: string): DenAuthDeepLink | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  if (routeHost !== "den-auth" && routePath !== "den-auth" && routeTail !== "den-auth") {
    return null;
  }

  const grant = url.searchParams.get("grant")?.trim() ?? "";
  const denBaseUrl = normalizeDenBaseUrl(url.searchParams.get("denBaseUrl")?.trim() ?? "") ?? DEFAULT_DEN_BASE_URL;
  if (!grant) {
    return null;
  }

  return { grant, denBaseUrl };
}

function normalizeDebugDeepLinkInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";

  const directMatch = trimmed.match(/(?:openwork-dev|openwork|https?):\/\/[^\s"'<>]+/i);
  if (directMatch) return directMatch[0];

  const bareShareMatch = trimmed.match(/share\.openwork(?:labs\.com|\.software)\/b\/[^\s"'<>]+/i);
  if (bareShareMatch) return `https://${bareShareMatch[0]}`;

  return trimmed;
}

export function parseDebugDeepLinkInput(rawValue: string):
  | { kind: "bundle"; link: SharedBundleDeepLink }
  | { kind: "remote"; link: RemoteWorkspaceDefaults }
  | { kind: "auth"; link: DenAuthDeepLink }
  | null {
  const normalized = normalizeDebugDeepLinkInput(rawValue);
  if (!normalized) return null;

  const denAuthLink = parseDenAuthDeepLink(normalized);
  if (denAuthLink) {
    return { kind: "auth", link: denAuthLink };
  }

  const sharedBundleLink = parseSharedBundleDeepLink(normalized);
  if (sharedBundleLink) {
    return { kind: "bundle", link: sharedBundleLink };
  }

  const remoteConnectLink = parseRemoteConnectDeepLink(normalized);
  if (remoteConnectLink) {
    return { kind: "remote", link: remoteConnectLink };
  }

  const bundleMatch = normalized.match(/ow_bundle=([^&\s]+)/i);
  if (bundleMatch?.[1]) {
    try {
      const bundleUrl = decodeURIComponent(bundleMatch[1]);
      const intentMatch = normalized.match(/(?:ow_intent|intent)=([^&\s]+)/i);
      const labelMatch = normalized.match(/ow_label=([^&\s]+)/i);
      const sourceMatch = normalized.match(/(?:ow_source|source)=([^&\s]+)/i);
      return {
        kind: "bundle",
        link: {
          bundleUrl,
          intent: normalizeSharedBundleImportIntent(intentMatch?.[1] ? decodeURIComponent(intentMatch[1]) : undefined),
          label: labelMatch?.[1] ? decodeURIComponent(labelMatch[1]) : undefined,
          source: sourceMatch?.[1] ? decodeURIComponent(sourceMatch[1]) : undefined,
        },
      };
    } catch {
      // ignore fallback parsing errors
    }
  }

  const shareIdMatch = normalized.match(/share\.openwork(?:labs\.com|\.software)\/b\/([^\s/?#"'<>]+)/i);
  if (shareIdMatch?.[1]) {
    return {
      kind: "bundle",
      link: {
        bundleUrl: `https://share.openworklabs.com/b/${shareIdMatch[1]}`,
        intent: "new_worker",
      },
    };
  }

  return null;
}

export function stripRemoteConnectQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of [
    "openworkHostUrl",
    "openworkUrl",
    "openworkToken",
    "accessToken",
    "workerId",
    "workerName",
    "autoConnect",
    "bypassModal",
    "bypassAddWorkerModal",
    "source",
  ]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}
