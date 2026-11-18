// V1 cancels foreground task jobs before it interrupts the parent runner. A
// cancelled child can therefore wake the parent's model continuation inside
// the abort request. Fence model dispatch until that native abort has settled;
// this does not alter tools, credentials, history, or the next user turn.
const stops = new WeakMap<object, Map<string, number>>();
// Native OpenCode canonicalizes macOS temporary paths; the workspace can keep
// their /var or /tmp aliases. Compare the same owner without probing the FS.
export function normalizeStopDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin" ? directory.replace(/^\/private\/(var|tmp)(\/|$)/, "/$1$2") : directory;
}
const key = (directory: string, sessionID: string) => JSON.stringify([normalizeStopDirectory(directory), sessionID]);

export function beginOpencodeStop(config: object, directory: string, sessionID: string): () => void {
  const active = stops.get(config) ?? new Map<string, number>();
  stops.set(config, active);
  const owner = key(directory, sessionID);
  active.set(owner, (active.get(owner) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (active.get(owner) ?? 1) - 1;
    if (remaining > 0) active.set(owner, remaining);
    else active.delete(owner);
  };
}

export function opencodeSessionIsStopping(config: object, input: Record<string, unknown>): boolean {
  return typeof input.directory === "string" && typeof input.sessionID === "string"
    && (stops.get(config)?.get(key(input.directory, input.sessionID)) ?? 0) > 0;
}
