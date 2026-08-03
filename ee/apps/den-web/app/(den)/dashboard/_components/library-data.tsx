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
  description: string | null;
  transport: "mcp" | "native";
  provider: string | null;
  state: "connected" | "needs_signin" | "needs_admin_setup" | "available";
  connectedAt: string | null;
  edges: LibraryAccessEdge[];
};

export type LibraryItem = LibraryPluginItem | LibraryConnectionItem;

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
  const description = readNullableString(value.description);
  const transport = readTransport(value.transport);
  const provider = readNullableString(value.provider);
  const state = readConnectionState(value.state);
  const connectedAt = readNullableString(value.connectedAt);
  const edges = parseEdges(value.edges);
  if (
    !id
    || !name
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
    description,
    transport,
    provider,
    state,
    connectedAt,
    edges,
  };
}

function parseLibraryItem(value: unknown): LibraryItem | null {
  if (!isRecord(value)) return null;
  if (value.type === "plugin") return parsePlugin(value);
  if (value.type === "connection") return parseConnection(value);
  return null;
}

export function parseLibraryPayload(payload: unknown): LibraryItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("Library response was incomplete.");
  }
  const items = payload.items
    .map(parseLibraryItem)
    .filter((item): item is LibraryItem => item !== null);
  if (items.length !== payload.items.length) {
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
