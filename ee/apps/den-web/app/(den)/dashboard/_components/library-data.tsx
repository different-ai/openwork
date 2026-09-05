"use client";

import { useQuery } from "@tanstack/react-query";

import { getErrorMessage, requestJson } from "../../_lib/den-flow";
import type { PluginAccessRole } from "./plugin-access-data";

type LibraryNamedEntity = {
  id: string;
  name: string;
};

type LibraryMemberEntity = {
  orgMembershipId: string;
  name: string;
};

export type LibraryAccessEdge =
  | { kind: "mine" }
  | { kind: "person"; sharedBy: LibraryMemberEntity | null; grantedAt: string }
  | { kind: "team"; team: LibraryNamedEntity }
  | { kind: "org_wide" }
  | { kind: "catalog"; marketplace: LibraryNamedEntity };

export type LibraryPluginItem = {
  type: "plugin";
  id: string;
  name: string;
  description: string | null;
  componentCount: number;
  componentKinds: string[];
  sourceRepositoryUrl: string | null;
  edges: LibraryAccessEdge[];
  role: PluginAccessRole;
};

export type LibraryConnectionItem = {
  type: "connection";
  id: string;
  name: string;
  url: string;
  description: string | null;
  transport: "mcp" | "native";
  provider: string | null;
  state: "connected" | "needs_signin" | "needs_admin_setup" | "available";
  connectedAt: string | null;
  edges: LibraryAccessEdge[];
};

export type LibraryWorkflowItem = {
  type: "workflow";
  id: string;
  plugin: LibraryNamedEntity | null;
  name: string;
  description: string | null;
  role: PluginAccessRole;
  edges: LibraryAccessEdge[];
  state: "ready" | "needs_signin" | "needs_admin_setup";
  resultState: "never_run" | "fresh" | "stale" | "needs_attention";
  latestSuccessfulAt: string | null;
  viewState: "default" | "custom_active" | "build_failed" | "retired";
  activeViewTitle: string | null;
  automationCount: number;
  source: { kind: "created" | "installed_template"; templateName?: string; templateVersion?: string };
};

export type LibraryItem = LibraryPluginItem | LibraryConnectionItem | LibraryWorkflowItem;

export const libraryQueryKeys = {
  items: ["me", "library"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readString(value) ?? undefined;
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.map(readString);
  if (strings.some((item) => item === null)) return null;
  return strings.filter((item): item is string => item !== null);
}

function readRole(value: unknown): PluginAccessRole | null {
  if (value === "viewer" || value === "editor" || value === "manager") return value;
  return null;
}

function readTransport(value: unknown): LibraryConnectionItem["transport"] | null {
  if (value === "mcp" || value === "native") return value;
  return null;
}

function readConnectionState(value: unknown): LibraryConnectionItem["state"] | null {
  if (value === "connected" || value === "needs_signin" || value === "needs_admin_setup" || value === "available") {
    return value;
  }
  return null;
}

function parseNamedEntity(value: unknown): LibraryNamedEntity | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const name = readString(value.name);
  return id && name ? { id, name } : null;
}

function parseMemberEntity(value: unknown): LibraryMemberEntity | null {
  if (!isRecord(value)) return null;
  const orgMembershipId = readString(value.orgMembershipId);
  const name = readString(value.name);
  return orgMembershipId && name ? { orgMembershipId, name } : null;
}

function parseEdge(value: unknown): LibraryAccessEdge | null {
  if (!isRecord(value)) return null;
  if (value.kind === "mine" || value.kind === "org_wide") {
    return { kind: value.kind };
  }
  if (value.kind === "person") {
    const sharedBy = value.sharedBy === null ? null : parseMemberEntity(value.sharedBy);
    const grantedAt = readString(value.grantedAt);
    if (sharedBy === null && value.sharedBy !== null) return null;
    return grantedAt ? { kind: "person", sharedBy, grantedAt } : null;
  }
  if (value.kind === "team") {
    const team = parseNamedEntity(value.team);
    return team ? { kind: "team", team } : null;
  }
  if (value.kind === "catalog") {
    const marketplace = parseNamedEntity(value.marketplace);
    return marketplace ? { kind: "catalog", marketplace } : null;
  }
  return null;
}

function parseEdges(value: unknown): LibraryAccessEdge[] | null {
  if (!Array.isArray(value)) return null;
  const edges = value.map(parseEdge);
  if (edges.some((edge) => edge === null)) return null;
  return edges.filter((edge): edge is LibraryAccessEdge => edge !== null);
}

function parsePlugin(value: Record<string, unknown>): LibraryPluginItem | null {
  const id = readString(value.id);
  const name = readString(value.name);
  const description = readNullableString(value.description);
  const sourceRepositoryUrl = readNullableString(value.sourceRepositoryUrl);
  const componentKinds = readStringArray(value.componentKinds);
  const role = readRole(value.role);
  const edges = parseEdges(value.edges);
  if (
    !id
    || !name
    || description === undefined
    || sourceRepositoryUrl === undefined
    || typeof value.componentCount !== "number"
    || !Number.isInteger(value.componentCount)
    || value.componentCount < 0
    || !componentKinds
    || !role
    || !edges
  ) {
    return null;
  }
  return {
    type: "plugin",
    id,
    name,
    description,
    componentCount: value.componentCount,
    componentKinds,
    sourceRepositoryUrl,
    edges,
    role,
  };
}

function parseConnection(value: Record<string, unknown>): LibraryConnectionItem | null {
  const id = readString(value.id);
  const name = readString(value.name);
  const url = readString(value.url);
  const description = readNullableString(value.description);
  const transport = readTransport(value.transport);
  const provider = readNullableString(value.provider);
  const state = readConnectionState(value.state);
  const connectedAt = readNullableString(value.connectedAt);
  const edges = parseEdges(value.edges);
  if (
    !id
    || !name
    || !url
    || description === undefined
    || !transport
    || provider === undefined
    || !state
    || connectedAt === undefined
    || !edges
  ) {
    return null;
  }
  return {
    type: "connection",
    id,
    name,
    url,
    description,
    transport,
    provider,
    state,
    connectedAt,
    edges,
  };
}

function parseWorkflow(value: Record<string, unknown>): LibraryWorkflowItem | null {
  const id = readString(value.id);
  const plugin = value.plugin === null ? null : parseNamedEntity(value.plugin);
  const name = readString(value.name);
  const description = readNullableString(value.description);
  const role = readRole(value.role);
  const edges = parseEdges(value.edges);
  const state = value.state === "ready" || value.state === "needs_signin" || value.state === "needs_admin_setup" ? value.state : null;
  const resultState = value.resultState === "never_run" || value.resultState === "fresh" || value.resultState === "stale" || value.resultState === "needs_attention" ? value.resultState : null;
  const latestSuccessfulAt = readNullableString(value.latestSuccessfulAt);
  const viewState = value.viewState === "default" || value.viewState === "custom_active" || value.viewState === "build_failed" || value.viewState === "retired" ? value.viewState : null;
  const activeViewTitle = readNullableString(value.activeViewTitle);
  const sourceKind = isRecord(value.source) && (value.source.kind === "created" || value.source.kind === "installed_template") ? value.source.kind : null;
  const source: LibraryWorkflowItem["source"] | null = isRecord(value.source) && sourceKind
    ? {
        kind: sourceKind,
        ...(readString(value.source.templateName) ? { templateName: readString(value.source.templateName) ?? undefined } : {}),
        ...(readString(value.source.templateVersion) ? { templateVersion: readString(value.source.templateVersion) ?? undefined } : {}),
      }
    : null;
  if (!id || (value.plugin !== null && !plugin) || !name || description === undefined || !role || !edges || !state || !resultState
    || latestSuccessfulAt === undefined || !viewState || activeViewTitle === undefined || !source
    || typeof value.automationCount !== "number" || !Number.isInteger(value.automationCount) || value.automationCount < 0) return null;
  return { type: "workflow", id, plugin, name, description, role, edges, state, resultState, latestSuccessfulAt, viewState, activeViewTitle, automationCount: value.automationCount, source };
}

function parseLibraryItem(value: unknown): LibraryItem | null {
  if (!isRecord(value)) return null;
  if (value.type === "plugin") return parsePlugin(value);
  if (value.type === "app") return null;
  if (value.type === "connection") return parseConnection(value);
  if (value.type === "workflow") return parseWorkflow(value);
  return null;
}

export function parseLibraryPayload(payload: unknown): LibraryItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("Library response was incomplete.");
  }
  const items = payload.items
    .map(parseLibraryItem)
    .filter((item): item is LibraryItem => item !== null);
  const supportedItemCount = payload.items.filter((item) => !isRecord(item) || item.type !== "app").length;
  if (items.length !== supportedItemCount) {
    throw new Error("Library response was incomplete.");
  }
  return items;
}

export function useLibrary() {
  return useQuery({
    queryKey: libraryQueryKeys.items,
    queryFn: async (): Promise<LibraryItem[]> => {
      const { response, payload } = await requestJson(
        "/v1/me/library",
        { method: "GET" },
        15000,
      );
      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load library (${response.status}).`));
      }
      return parseLibraryPayload(payload);
    },
  });
}
