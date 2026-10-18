import type { QueryClient } from "@tanstack/react-query";

/** Denial markers must be re-readable immediately when their scope is enabled. */
export const PERMISSION_READ_STALE_TIME = 0;

export const permissionsQueryKeys = {
  all: (orgId: string) => ["permissions", orgId],
  sets: (orgId: string, viewerId?: string) => viewerId === undefined ? ["permissions", orgId, "sets"] : ["permissions", orgId, "sets", viewerId],
  set: (orgId: string, setId: string, viewerId?: string) => viewerId === undefined ? ["permissions", orgId, "set", setId] : ["permissions", orgId, "set", setId, viewerId],
  history: (orgId: string, setId: string) => ["permissions", orgId, "history", setId],
  key: (orgId: string, key: string) => ["permissions", orgId, "key", key],
  member: (orgId: string, memberId: string) => ["permissions", orgId, "member", memberId],
};

/**
 * A denied role read erases this viewer's protected projections, not other
 * viewers' cache. Cancel older in-flight reads first so a late response cannot
 * restore data from before the denial. Null remains a barrier through remounts
 * and transient failures; only a new authorized payload replaces it.
 */
export async function clearDeniedRoleReads(client: QueryClient, orgId: string, viewerId: string) {
  const ownedRoleRead = (key: readonly unknown[]) => key[0] === "permissions" && key[1] === orgId
    && (key[2] === "sets" || key[2] === "set") && key[key.length - 1] === viewerId;
  await client.cancelQueries({ queryKey: permissionsQueryKeys.all(orgId), predicate: (query) => ownedRoleRead(query.queryKey) }, { revert: false });
  client.setQueryData(permissionsQueryKeys.sets(orgId, viewerId), null);
  for (const query of client.getQueryCache().findAll({ queryKey: permissionsQueryKeys.all(orgId) })) {
    if (ownedRoleRead(query.queryKey)) client.setQueryData(query.queryKey, null);
  }
}
