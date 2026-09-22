import { randomBytes, randomUUID } from "node:crypto";
import { Freestyle, FreestyleApiError } from "freestyle";
import type { Vm } from "freestyle";

export const PREVIEW_KIND = "openwork-review-v1";
export const ACCESS_FILE = "/opt/openwork-preview/access.json";

export function client(): Freestyle {
  const apiKey = process.env.FREESTYLE_API_KEY?.trim();
  if (!apiKey) throw new Error("FREESTYLE_API_KEY is required on the review server.");
  return new Freestyle({ apiKey, fetch });
}

export function snapshotSlug(sha: string): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  return `openwork-web-v1-${sha}`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof FreestyleApiError && error.status === 404;
}

export async function findSnapshot(sha: string, api = client()) {
  try { return await api.vms.snapshots.get(snapshotSlug(sha)); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

export async function execChecked(vm: Vm, command: string, timeoutMs = 120_000): Promise<string> {
  const result = await vm.exec({ command, timeoutMs, linuxUser: "root" });
  if (result.statusCode !== 0) throw new Error(`Freestyle guest command failed (${result.statusCode}). Inspect the builder's private logs.`);
  return result.stdout ?? "";
}

export interface PreviewSession {
  id: string;
  snapshotId: string;
  gitSha: string;
  url: string;
  expiresAt: string;
}

/** Every call creates a VM. Neither reports nor visitors ever key a reusable VM. */
export async function launchPreview(
  input: { gitSha: string; reportId?: string; lifetimeMinutes?: number },
  api = client(),
  probe: typeof fetch = fetch,
): Promise<PreviewSession> {
  const snapshot = await findSnapshot(input.gitSha, api);
  if (!snapshot) throw new Error("This commit has no Freestyle snapshot yet.");
  const minutes = input.lifetimeMinutes ?? 120;
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 1430) throw new Error("Preview lifetime must be 10–1430 minutes.");
  const launchId = randomUUID().replaceAll("-", "");
  const domain = `ow-${launchId}.style.dev`;
  const token = randomBytes(32).toString("base64url");
  const { vm, vmId, data } = await api.vms.create({
    snapshotId: snapshot.id, slug: `ow-preview-${launchId}`,
    displayName: `OpenWork preview ${input.gitSha.slice(0, 7)}`,
    ttlSeconds: minutes * 60, idleTimeoutSeconds: 600,
    metadata: { kind: PREVIEW_KIND, gitSha: input.gitSha, ...(input.reportId ? { reportId: input.reportId } : {}) },
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    // Inline rules share the VM lifecycle and disappear with its provider TTL.
    tls: { rules: [{ action: "allow", domain, source: { public: true }, destination: { port: 8080 } }] },
  });
  try {
    const expiresAt = new Date(Date.parse(data.createdAt) + minutes * 60_000).toISOString();
    await vm.fs.writeTextFile(ACCESS_FILE, JSON.stringify({ token, expiresAt }));
    await execChecked(vm, "chmod 600 /opt/openwork-preview/access.json && curl -fsS http://127.0.0.1:5178/ >/dev/null");
    const url = `https://${domain}/__openwork_launch?token=${token}`;
    const response = await probe(url, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status !== 303 || !response.headers.get("set-cookie")?.startsWith("__Host-openwork-preview=")) {
      throw new Error("Freestyle preview could not be reached. Try launching again.");
    }
    return { id: vmId, snapshotId: snapshot.id, gitSha: input.gitSha, url, expiresAt };
  } catch (error) {
    await vm.delete().catch(() => undefined); // Provider TTL still bounds failed cleanup.
    throw error;
  }
}

export async function deletePreview(id: string, api = client()): Promise<void> {
  let vm;
  try { vm = await api.vms.get(id); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (vm.metadata.kind !== PREVIEW_KIND) throw new Error("Refusing to delete a VM not owned by OpenWork previews.");
  await api.vms.delete(vm.id);
}
