type Identity = { scope: string | null; sessionID: string; messageID: string; callID: string };
type Snapshot = Identity & { updatedAt: number; metadata: Record<string, unknown> };
const KEY = "openwork.v2.live-tool-progress.v1";
const MAX_BYTES = 1_024 * 1_024;
const MAX_SNAPSHOT_BYTES = 256 * 1_024;
const MAX_ENTRIES = 64;
const MAX_AGE_MS = 6 * 60 * 60 * 1_000;
const encoder = new TextEncoder();
const same = (a: Identity, b: Identity) => a.scope === b.scope && a.sessionID === b.sessionID && a.messageID === b.messageID && a.callID === b.callID;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function read(): Snapshot[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(KEY);
    if (!raw || raw.length > MAX_BYTES || encoder.encode(raw).byteLength > MAX_BYTES) return [];
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry): entry is Snapshot => record(entry)
      && typeof entry.scope === "string" && typeof entry.sessionID === "string"
      && typeof entry.messageID === "string" && typeof entry.callID === "string"
      && typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      && entry.updatedAt <= Date.now() && Date.now() - entry.updatedAt <= MAX_AGE_MS
      && record(entry.metadata)).slice(-MAX_ENTRIES);
  } catch { return []; }
}

function write(entries: Snapshot[]): void {
  try {
    entries = entries.slice(-MAX_ENTRIES);
    let serialized = JSON.stringify(entries);
    while (entries.length && encoder.encode(serialized).byteLength > MAX_BYTES) {
      entries.shift(); serialized = JSON.stringify(entries);
    }
    if (entries.length) globalThis.sessionStorage?.setItem(KEY, serialized);
    else globalThis.sessionStorage?.removeItem(KEY);
  } catch { /* Live rendering still works when tab storage is unavailable. */ }
}

/** Pinned v2 history omits running metadata; retain only progress actually observed by this tab. */
export function rememberV2LiveToolProgress(identity: Identity, source: Record<string, unknown>): void {
  if (!identity.scope || !Array.isArray(source.toolCalls) || !source.toolCalls.length) return;
  const metadata = { toolCalls: source.toolCalls,
    ...(Array.isArray(source.openworkToolDetails) ? { openworkToolDetails: source.openworkToolDetails } : {}),
    ...(source.openworkToolDetailsTruncated === true ? { openworkToolDetailsTruncated: true } : {}) };
  const entries = read().filter(entry => !same(entry, identity));
  try {
    const next = { ...identity, updatedAt: Date.now(), metadata };
    if (encoder.encode(JSON.stringify(next)).byteLength <= MAX_SNAPSHOT_BYTES) entries.push(next);
  } catch { /* A malformed snapshot cannot prevent native event handling. */ }
  write(entries);
}

/** Call only for an execution that authoritative native history still identifies as running. */
export function restoreV2LiveToolProgress(identity: Identity): Record<string, unknown> {
  return identity.scope ? read().find(entry => same(entry, identity))?.metadata ?? {} : {};
}

export function forgetV2LiveToolProgress(identity: Identity): void {
  if (identity.scope) write(read().filter(entry => !same(entry, identity)));
}
