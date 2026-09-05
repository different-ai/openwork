import { normalizeMcpSlug } from "../../../app/mcp";
import type { McpServerEntry, McpStatus, McpStatusMap } from "../../../app/types";

type ObservedMcpStatus = McpStatus | { status: "disconnected" };
type ObservedMcpStatusMap = Record<string, ObservedMcpStatus>;

export type McpStatusRefreshToken = {
  id: number;
  workspaceKey: string;
};

function isTerminalStatus(status: ObservedMcpStatus): status is Exclude<McpStatus, { status: "connected" }> {
  return status.status === "disabled"
    || status.status === "failed"
    || status.status === "needs_auth"
    || status.status === "needs_client_registration"
    || status.status === "reconnect_required";
}

function identityAliases(entry: Pick<McpServerEntry, "id" | "name">) {
  return [entry.id, entry.name]
    .flatMap((value) => value?.trim() ? [value.trim()] : [])
    .filter((value, index, aliases) => aliases.indexOf(value) === index);
}

function normalizedIdentity(value: string) {
  return normalizeMcpSlug(value.trim());
}

export function resolveMcpStatusByIdentity<T>(
  observed: Record<string, T>,
  identities: Array<string | null | undefined>,
): T | undefined {
  const aliases = identities
    .flatMap((value) => value?.trim() ? [value.trim()] : [])
    .filter((value, index, values) => values.indexOf(value) === index);
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(observed, alias)) return observed[alias];
  }

  const normalizedAliases = new Set(aliases.map(normalizedIdentity));
  const matches = Object.entries(observed).filter(([name]) => normalizedAliases.has(normalizedIdentity(name)));
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

export function resolveObservedMcpStatus(
  observed: ObservedMcpStatusMap,
  entry: Pick<McpServerEntry, "id" | "name">,
): ObservedMcpStatus | undefined {
  return resolveMcpStatusByIdentity(observed, identityAliases(entry));
}

/**
 * Owns the short hand-off from a successful OAuth producer response to the
 * engine's eventually-consistent MCP status snapshot.
 */
export function createMcpStatusSynchronizer(options?: { maxPendingRefreshes?: number }) {
  const maxPendingRefreshes = options?.maxPendingRefreshes ?? 6;
  let workspaceKey = "";
  let latestRefreshId = 0;
  const pendingAuthenticated = new Map<string, number>();

  const selectWorkspace = (nextWorkspaceKey: string) => {
    if (workspaceKey === nextWorkspaceKey) return;
    workspaceKey = nextWorkspaceKey;
    pendingAuthenticated.clear();
  };

  const pendingKeyForEntry = (entry: Pick<McpServerEntry, "id" | "name">) => {
    for (const alias of identityAliases(entry)) {
      const key = normalizedIdentity(alias);
      if (pendingAuthenticated.has(key)) return key;
    }
    return null;
  };

  const isCurrent = (token: McpStatusRefreshToken) =>
    token.workspaceKey === workspaceKey && token.id === latestRefreshId;

  return {
    beginRefresh(nextWorkspaceKey: string): McpStatusRefreshToken {
      selectWorkspace(nextWorkspaceKey);
      latestRefreshId += 1;
      return { id: latestRefreshId, workspaceKey: nextWorkspaceKey };
    },

    isCurrent(token: McpStatusRefreshToken) {
      return isCurrent(token);
    },

    recordAuthenticated(nextWorkspaceKey: string, name: string) {
      selectWorkspace(nextWorkspaceKey);
      pendingAuthenticated.set(normalizedIdentity(name), maxPendingRefreshes);
    },

    isPending(nextWorkspaceKey: string, name: string) {
      return nextWorkspaceKey === workspaceKey && pendingAuthenticated.has(normalizedIdentity(name));
    },

    project(
      token: McpStatusRefreshToken,
      observed: ObservedMcpStatusMap,
      entries: McpServerEntry[],
    ): McpStatusMap | null {
      if (!isCurrent(token)) return null;

      const statuses: McpStatusMap = {};
      const presentPendingKeys = new Set<string>();
      for (const entry of entries) {
        const pendingKey = pendingKeyForEntry(entry);
        if (pendingKey) presentPendingKeys.add(pendingKey);

        if (entry.config.enabled === false) {
          statuses[entry.name] = { status: "disabled" };
          if (pendingKey) pendingAuthenticated.delete(pendingKey);
          continue;
        }

        const status = resolveObservedMcpStatus(observed, entry);
        if (status?.status === "connected") {
          statuses[entry.name] = status;
          if (pendingKey) pendingAuthenticated.delete(pendingKey);
          continue;
        }
        if (status && isTerminalStatus(status)) {
          statuses[entry.name] = status;
          if (pendingKey) pendingAuthenticated.delete(pendingKey);
          continue;
        }

        if (pendingKey) {
          const remaining = pendingAuthenticated.get(pendingKey) ?? 0;
          if (remaining > 1) {
            statuses[entry.name] = { status: "connected" };
            pendingAuthenticated.set(pendingKey, remaining - 1);
          } else {
            pendingAuthenticated.delete(pendingKey);
          }
        }
      }

      for (const key of pendingAuthenticated.keys()) {
        if (!presentPendingKeys.has(key)) pendingAuthenticated.delete(key);
      }
      return statuses;
    },
  };
}
