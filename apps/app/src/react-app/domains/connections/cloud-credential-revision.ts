type CloudCredentialScope = { serverBaseUrl: string; workspaceId: string };

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
