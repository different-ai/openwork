import { createHash, randomBytes, randomUUID } from "node:crypto";
import { FreestyleApiError } from "freestyle";
import { ACCESS_FILE, client, execChecked, isMissing, waitForPublicAccess } from "./index.ts";
import { parseEvidenceCheckpoint, type EvidenceCheckpoint } from "./checkpoint-schema.ts";

export const EVIDENCE_KIND = "openwork-evidence-source-v1";
export const FORK_KIND = "openwork-evidence-fork-v1";
const root = "/opt/openwork-preview";
const manifest = `${root}/checkpoint.json`;
export class CheckpointUnavailable extends Error {}
export class CheckpointCapacity extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export interface EvidenceSession {
  id: string;
  sourceSha: string;
  url: string;
  cdpOrigin: string;
  cookie: string;
  expiresAt: string;
}

export async function readEvidenceSession(id: string, sourceSha: string, api = client()): Promise<EvidenceSession> {
  const owner = await api.vms.get(id);
  if (![EVIDENCE_KIND, FORK_KIND].includes(owner.metadata.kind) || owner.metadata.sourceSha !== sourceSha) throw new Error("Not an owned evidence VM");
  const value: unknown = JSON.parse(await api.vms.ref(id).fs.readTextFile(ACCESS_FILE));
  if (!record(value) || typeof value.token !== "string" || !/^[\w-]{43}$/.test(value.token)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() || !record(value.origins)
    || typeof value.origins.desktop !== "string" || typeof value.origins.cdp !== "string"
    || !/^https:\/\/evidence-[a-f0-9]{32}\.preview\.openwork\.software$/.test(value.origins.desktop)
    || !/^https:\/\/cdp-[a-f0-9]{32}\.preview\.openwork\.software$/.test(value.origins.cdp)) throw new Error("Invalid evidence access configuration");
  return { id, sourceSha, url: `${value.origins.desktop}/__openwork_launch?token=${value.token}`,
    cdpOrigin: value.origins.cdp, cookie: `__Host-openwork-preview=${value.token}`, expiresAt: value.expiresAt };
}

async function allocate(input: { snapshotId: string; slug: string; kind: string; sourceSha: string; metadata?: Record<string, string> }, api: ReturnType<typeof client>, probe: typeof fetch = fetch) {
  const nonce = randomUUID().replaceAll("-", "");
  const origins = { desktop: `https://evidence-${nonce}.preview.openwork.software`, cdp: `https://cdp-${nonce}.preview.openwork.software` };
  const created = await api.vms.create({
    snapshotId: input.snapshotId, slug: input.slug, ttlSeconds: 3600, idleTimeoutSeconds: 600,
    metadata: { kind: input.kind, sourceSha: input.sourceSha, ...input.metadata },
    // All runtime services and mocked inference are inside this VM. No egress.
    firewall: { rules: [] },
    tls: { rules: Object.values(origins).map((origin) => ({ action: "allow", domain: new URL(origin).hostname, source: { public: true }, destination: { port: 8080 } })) },
  });
  try {
    if ((await created.vm.fs.readTextFile(`${root}/source-sha`)).trim() !== input.sourceSha
      || (await created.vm.fs.readTextFile(`${root}/evidence-ready`)).trim() !== "web-v1") throw new Error("Evidence world source mismatch");
    const expiresAt = new Date(Date.parse(created.data.createdAt) + 3600_000).toISOString();
    await created.vm.fs.writeTextFile(ACCESS_FILE, JSON.stringify({ token: randomBytes(32).toString("base64url"), expiresAt, origins }), { mode: 0o600 });
    const result = await readEvidenceSession(created.vmId, input.sourceSha, api);
    await waitForPublicAccess(result.url, probe, undefined, "desktop");
    return result;
  } catch (error) { await created.vm.delete().catch(() => undefined); throw error; }
}

export async function launchEvidenceWorld(snapshotId: string, sourceSha: string, api = client(), probe: typeof fetch = fetch) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("Full source SHA required");
  return allocate({ snapshotId, sourceSha, slug: `ow-evidence-source-${randomUUID().replaceAll("-", "")}`, kind: EVIDENCE_KIND }, api, probe);
}

export async function captureEvidenceCheckpoint(input: { vmId: string; sourceSha: string; imageHash: string }, api = client()): Promise<EvidenceCheckpoint> {
  const vm = await api.vms.get(input.vmId);
  if (vm.metadata.kind !== EVIDENCE_KIND || vm.metadata.sourceSha !== input.sourceSha) throw new Error("Checkpoint source is not an owned evidence world");
  const handle = api.vms.ref(vm.id);
  const countPath = `${root}/checkpoint-count`;
  const count = await handle.fs.exists(countPath) ? Number(await handle.fs.readTextFile(countPath)) : 0;
  if (!Number.isInteger(count) || count < 0 || count >= 10) throw new CheckpointCapacity("This proof has reached its ten-checkpoint limit");
  const now = Date.now();
  const checkpoint = parseEvidenceCheckpoint({ version: 1, provider: "freestyle", id: `ow-evidence-v1-${randomUUID().replaceAll("-", "")}`,
    sourceSha: input.sourceSha, imageHash: input.imageHash, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400_000).toISOString() });
  await handle.fs.writeTextFile(countPath, String(count + 1));
  await handle.fs.writeTextFile(manifest, JSON.stringify(checkpoint), { mode: 0o600 });
  const result = await handle.snapshot({ slug: checkpoint.id, ttlSeconds: 86400, autoDeleteSeconds: 86400 });
  if (result.snapshot.public) { await api.vms.snapshots.delete(result.snapshotId); throw new Error("Evidence snapshots must be private"); }
  return checkpoint;
}

/** Caller resolves checkpoint from the authenticated immutable report, never the request body. */
export async function forkEvidenceCheckpoint(value: unknown, reportId: string, requestId: string, api = client(), probe: typeof fetch = fetch): Promise<EvidenceSession> {
  const checkpoint = parseEvidenceCheckpoint(value);
  if (!/^[a-f0-9]{32}$/.test(reportId) || !/^[a-f0-9-]{36}$/.test(requestId)) throw new Error("Invalid fork request");
  if (Date.parse(checkpoint.expiresAt) <= Date.now()) throw new CheckpointUnavailable("This checkpoint has expired");
  let snapshot;
  try { snapshot = await api.vms.snapshots.get(checkpoint.id); }
  catch (error) { if (isMissing(error)) throw new CheckpointUnavailable("This checkpoint is no longer available"); throw error; }
  if (snapshot.public || snapshot.slug !== checkpoint.id) throw new CheckpointUnavailable("Invalid evidence snapshot");
  const key = createHash("sha256").update(checkpoint.id).digest("hex").slice(0, 24);
  // Provider-enforced unique slots bound concurrent forks across server instances.
  for (let slot = 0; slot < 3; slot++) {
    const slug = `ow-evidence-fork-${key}-${slot}`;
    try {
      const result = await allocate({ snapshotId: snapshot.id, slug, kind: FORK_KIND, sourceSha: checkpoint.sourceSha,
        metadata: { reportId, requestId, checkpoint: checkpoint.id } }, api, probe);
      try {
        const restored = parseEvidenceCheckpoint(JSON.parse(await api.vms.ref(result.id).fs.readTextFile(manifest)));
        if (JSON.stringify(restored) !== JSON.stringify(checkpoint)) throw new CheckpointUnavailable("Checkpoint does not match its screenshot");
        return result;
      } catch (error) { await api.vms.delete(result.id); throw error; }
    } catch (error) {
      if (!(error instanceof FreestyleApiError) || error.status !== 409) throw error;
      const existing = await api.vms.get(slug).catch((cause: unknown) => { if (isMissing(cause)) return null; throw cause; });
      if (!existing) throw error; // Account quota, not an occupied slot.
      if (existing.metadata.kind === FORK_KIND && existing.metadata.reportId === reportId && existing.metadata.requestId === requestId) {
        return readEvidenceSession(existing.id, checkpoint.sourceSha, api);
      }
    }
  }
  throw new CheckpointCapacity("Three forks are already open for this checkpoint. Try again after one expires.");
}

export async function deleteEvidenceVm(id: string, api = client()) {
  const vm = await api.vms.get(id).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
  if (!vm) return;
  if (![EVIDENCE_KIND, FORK_KIND].includes(vm.metadata.kind)) throw new Error("Refusing to delete an unrelated VM");
  await api.vms.delete(id);
}

export async function continueEvidenceStream(id: string, api = client()) {
  const vm = await api.vms.get(id);
  if (![EVIDENCE_KIND, FORK_KIND].includes(vm.metadata.kind)) throw new Error("Not an evidence VM");
  await execChecked(api.vms.ref(id), "node /opt/openwork-preview/evidence-control.mjs continue", 15_000);
}
