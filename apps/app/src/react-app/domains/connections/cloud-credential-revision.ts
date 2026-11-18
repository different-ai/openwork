type CloudCredentialScope = { serverBaseUrl: string; workspaceId: string };

// Keep only a revision per runtime scope, never credentials. Failed App views
// wait for a real token installation rather than retrying unchanged access.
let revision = 0;
const scopeRevisions = new Map<string, number>();
const listeners = new Set<() => void>();

function scopeKey(scope: CloudCredentialScope): string {
  return JSON.stringify([scope.serverBaseUrl.replace(/\/+$/, ""), scope.workspaceId]);
}

export function readCloudCredentialRevision(scope?: CloudCredentialScope): number {
  return scope ? scopeRevisions.get(scopeKey(scope)) ?? 0 : revision;
}

export function markCloudCredentialRefreshed(scope: CloudCredentialScope): void {
  scopeRevisions.set(scopeKey(scope), ++revision);
  for (const listener of [...listeners]) listener();
}

/** One retry after a matching installation, including one that finished while
 * the old request was still in flight. The caller owns cancellation. */
export function onCloudCredentialRefreshed(
  scopes: CloudCredentialScope[],
  since: number,
  onRefresh: () => void,
): () => void {
  const keys = scopes.map(scopeKey);
  const listener = () => {
    if (!keys.some(key => (scopeRevisions.get(key) ?? 0) > since)) return;
    listeners.delete(listener);
    onRefresh();
  };
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}
