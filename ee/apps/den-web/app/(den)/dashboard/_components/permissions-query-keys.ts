export const permissionsQueryKeys = {
  all: (orgId: string) => ["permissions", orgId],
  sets: (orgId: string) => ["permissions", orgId, "sets"],
  set: (orgId: string, setId: string) => ["permissions", orgId, "set", setId],
  history: (orgId: string, setId: string) => ["permissions", orgId, "history", setId],
  key: (orgId: string, key: string) => ["permissions", orgId, "key", key],
  member: (orgId: string, memberId: string) => ["permissions", orgId, "member", memberId],
};
