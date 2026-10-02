/** Portable evidence metadata only. Never put viewer URLs or credentials here. */
export interface EvidenceCheckpoint {
  version: 1;
  provider: "freestyle";
  id: string;
  sourceSha: string;
  imageHash: string;
  capturedAt: string;
  expiresAt: string;
}

export function parseEvidenceCheckpoint(value: unknown): EvidenceCheckpoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid checkpoint");
  if (!("version" in value) || value.version !== 1 || !("provider" in value) || value.provider !== "freestyle"
    || !("id" in value) || typeof value.id !== "string" || !/^ow-evidence-v1-[a-f0-9]{32}$/.test(value.id)
    || !("sourceSha" in value) || typeof value.sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceSha)
    || !("imageHash" in value) || typeof value.imageHash !== "string" || !/^[a-f0-9]{64}$/.test(value.imageHash)
    || !("capturedAt" in value) || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))
    || !("expiresAt" in value) || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error("Invalid checkpoint fields");
  const lifetime = Date.parse(value.expiresAt) - Date.parse(value.capturedAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60_000) throw new Error("Invalid checkpoint lifetime");
  return { version: 1, provider: "freestyle", id: value.id, sourceSha: value.sourceSha, imageHash: value.imageHash,
    capturedAt: value.capturedAt, expiresAt: value.expiresAt };
}
