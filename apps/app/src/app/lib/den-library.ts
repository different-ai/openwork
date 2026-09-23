export type DenLibraryAccessRole = "viewer" | "editor" | "manager" | "owner";

export type DenLibraryAccessEdge =
  | { kind: "mine" }
  | { kind: "person"; sharedById: string | null; sharedByName: string | null; grantedAt: string | null }
  | { kind: "team"; teamId: string; teamName: string }
  | { kind: "org_wide" }
  | { kind: "catalog"; marketplaceName: string };

export type DenLibraryPluginItem = {
  type: "plugin";
  id: string;
  name: string;
  description: string | null;
  componentKinds: string[];
  componentCount: number;
  role: DenLibraryAccessRole;
  edges: DenLibraryAccessEdge[];
};

export type DenLibraryConnectionState = "connected" | "needs_signin" | "needs_admin_setup" | "available";

export type DenLibraryConnectionItem = {
  type: "connection";
  id: string;
  name: string;
  description: string | null;
  url: string;
  provider: string | null;
  transport: "mcp" | "native";
  state: DenLibraryConnectionState;
  edges: DenLibraryAccessEdge[];
};

export type DenLibraryItem = DenLibraryPluginItem | DenLibraryConnectionItem;

export type DenLibraryAccessGrant = {
  id: string;
  orgMembershipId: string | null;
  teamId: string | null;
  orgWide: boolean;
  role: DenLibraryAccessRole;
};

export type DenLibraryTeam = {
  id: string;
  name: string;
  memberIds: string[];
};

export type DenLibraryMember = {
  id: string;
  name: string;
  email: string | null;
};

export type DenLibraryOrgDirectory = {
  currentMemberId: string | null;
  members: DenLibraryMember[];
  teams: DenLibraryTeam[];
};

export type DenLibraryPluginFile = {
  configObjectId: string;
  objectType: string;
  title: string;
  description: string | null;
  /** The latest version's source, when Den includes it with the file. */
  rawSourceText: string | null;
};

export type DenLibraryConfigObjectVersion = {
  id: string;
  rawSourceText: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readString = (value: unknown) => (typeof value === "string" ? value : null);

const accessRoles: readonly DenLibraryAccessRole[] = ["viewer", "editor", "manager", "owner"];

function readRole(value: unknown): DenLibraryAccessRole {
  return accessRoles.find((role) => role === value) ?? "viewer";
}

const connectionStates: readonly DenLibraryConnectionState[] = ["connected", "needs_signin", "needs_admin_setup", "available"];

function readConnectionState(value: unknown): DenLibraryConnectionState {
  return connectionStates.find((state) => state === value) ?? "available";
}

function readEdge(value: unknown): DenLibraryAccessEdge[] {
  if (!isRecord(value)) return [];
  switch (value.kind) {
    case "mine":
      return [{ kind: "mine" }];
    case "org_wide":
      return [{ kind: "org_wide" }];
    case "person": {
      const sharedBy = isRecord(value.sharedBy) ? value.sharedBy : null;
      return [{
        kind: "person",
        sharedById: readString(sharedBy?.orgMembershipId),
        sharedByName: readString(sharedBy?.name),
        grantedAt: readString(value.grantedAt),
      }];
    }
    case "team": {
      const team = isRecord(value.team) ? value.team : null;
      const teamId = readString(team?.id);
      const teamName = readString(team?.name);
      return teamId && teamName ? [{ kind: "team", teamId, teamName }] : [];
    }
    case "catalog": {
      const marketplace = isRecord(value.marketplace) ? value.marketplace : null;
      return [{ kind: "catalog", marketplaceName: readString(marketplace?.name) ?? "" }];
    }
    default:
      return [];
  }
}

function readEdges(value: unknown): DenLibraryAccessEdge[] {
  return Array.isArray(value) ? value.flatMap(readEdge) : [];
}

export function parseDenLibraryItems(payload: unknown): DenLibraryItem[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((item): DenLibraryItem[] => {
    if (!isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string") return [];
    if (item.type === "plugin") {
      return [{
        type: "plugin",
        id: item.id,
        name: item.name,
        description: readString(item.description),
        componentKinds: Array.isArray(item.componentKinds)
          ? item.componentKinds.filter((kind): kind is string => typeof kind === "string")
          : [],
        componentCount: typeof item.componentCount === "number" ? item.componentCount : 0,
        role: readRole(item.role),
        edges: readEdges(item.edges),
      }];
    }
    if (item.type === "connection") {
      return [{
        type: "connection",
        id: item.id,
        name: item.name,
        description: readString(item.description),
        url: readString(item.url) ?? "",
        provider: readString(item.provider),
        transport: item.transport === "native" ? "native" : "mcp",
        state: readConnectionState(item.state),
        edges: readEdges(item.edges),
      }];
    }
    return [];
  });
}

export function parseDenLibraryAccessGrants(payload: unknown): DenLibraryAccessGrant[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((grant): DenLibraryAccessGrant[] => {
    if (!isRecord(grant) || typeof grant.id !== "string" || grant.removedAt) return [];
    return [{
      id: grant.id,
      orgMembershipId: readString(grant.orgMembershipId),
      teamId: readString(grant.teamId),
      orgWide: grant.orgWide === true,
      role: readRole(grant.role),
    }];
  });
}

export function parseDenLibraryAccessGrant(payload: unknown): DenLibraryAccessGrant | null {
  const item = isRecord(payload) ? payload.item : null;
  return parseDenLibraryAccessGrants({ items: [item] })[0] ?? null;
}

export function parseDenLibraryOrgDirectory(payload: unknown): DenLibraryOrgDirectory {
  const root = isRecord(payload) ? payload : {};
  const currentMember = isRecord(root.currentMember) ? root.currentMember : null;
  const members = Array.isArray(root.members)
    ? root.members.flatMap((member): DenLibraryMember[] => {
      if (!isRecord(member) || typeof member.id !== "string") return [];
      const user = isRecord(member.user) ? member.user : null;
      const email = readString(user?.email);
      const name = readString(user?.name)?.trim() || email || member.id;
      return [{ id: member.id, name, email }];
    })
    : [];
  const teams = Array.isArray(root.teams)
    ? root.teams.flatMap((team): DenLibraryTeam[] => {
      if (!isRecord(team) || typeof team.id !== "string" || typeof team.name !== "string") return [];
      const memberIds = Array.isArray(team.memberIds)
        ? team.memberIds.filter((id): id is string => typeof id === "string")
        : [];
      return [{ id: team.id, name: team.name, memberIds }];
    })
    : [];
  return { currentMemberId: readString(currentMember?.id), members, teams };
}

export function parseDenLibraryPluginFiles(payload: unknown): DenLibraryPluginFile[] {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  return payload.items.flatMap((membership): DenLibraryPluginFile[] => {
    if (!isRecord(membership) || membership.removedAt) return [];
    const configObject = isRecord(membership.configObject) ? membership.configObject : null;
    const configObjectId = readString(membership.configObjectId) ?? readString(configObject?.id);
    if (!configObjectId) return [];
    const latestVersion = isRecord(configObject?.latestVersion) ? configObject.latestVersion : null;
    return [{
      configObjectId,
      objectType: readString(configObject?.objectType) ?? "",
      title: readString(configObject?.title) ?? "",
      description: readString(configObject?.description),
      rawSourceText: readString(latestVersion?.rawSourceText),
    }];
  });
}

export function parseDenLibraryConfigObjectVersion(payload: unknown): DenLibraryConfigObjectVersion | null {
  const item = isRecord(payload) && isRecord(payload.item) ? payload.item : isRecord(payload) ? payload : null;
  if (!item || typeof item.id !== "string") return null;
  return { id: item.id, rawSourceText: readString(item.rawSourceText) };
}
