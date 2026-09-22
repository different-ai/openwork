import { templateOrigins } from "./origins.mjs";
import { parsePreviewOutputs, type PreviewOutputs } from "./outputs.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Freestyle, FreestyleApiError } from "freestyle";
import type { Vm } from "freestyle";

export const PREVIEW_KIND = "openwork-review-v1";
export const ACCESS_FILE = "/opt/openwork-preview/access.json";

export function client(): Freestyle {
  const apiKey = process.env.FREESTYLE_API_KEY?.trim();
  if (!apiKey) throw new Error("FREESTYLE_API_KEY is required on the review server.");
  return new Freestyle({ apiKey, fetch });
}

export type PreviewWorld = "app-web" | "acme-web";
export function previewWorld(value: unknown): PreviewWorld {
  if (value === "app-web" || value === "acme-web") return value;
  throw new Error("Unsupported preview world.");
}

export function snapshotSlug(sha: string, world: PreviewWorld = "app-web"): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  return `openwork-${previewWorld(world)}-v4-${sha}`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof FreestyleApiError && error.status === 404;
}

export async function findSnapshot(sha: string, api = client(), world: PreviewWorld = "app-web") {
  try { return await api.vms.snapshots.get(snapshotSlug(sha, world)); }
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
  world: PreviewWorld;
  outputs: PreviewOutputs;
}

export class PreviewLaunchError extends Error {
  readonly stage: string;
  readonly vmId: string;
  constructor(stage: string, vmId: string, cause: unknown) {
    super("Freestyle preview could not be reached. Try launching again.", { cause });
    this.name = "PreviewLaunchError";
    this.stage = stage;
    this.vmId = vmId;
  }
}

/** New TLS routes can briefly return 404/502 before the restored VM is reachable. */
export async function waitForPublicAccess(url: string, probe: typeof fetch = fetch, pause = delay): Promise<void> {
  let status = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await probe(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
      status = response.status;
      const ready = status === 303 && response.headers.get("set-cookie")?.startsWith("__Host-openwork-preview=");
      await response.body?.cancel();
      if (ready) return;
      if (![404, 408, 425, 429].includes(status) && status < 500) break;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
    }
    if (attempt < 7) await pause(250);
  }
  throw new Error(`Public sandbox readiness failed (HTTP ${status || "unreachable"}).`);
}

/** Every call creates a VM. Neither reports nor visitors ever key a reusable VM. */
export async function launchPreview(
  input: { gitSha: string; reportId?: string; lifetimeMinutes?: number; world?: PreviewWorld },
  api = client(),
  probe: typeof fetch = fetch,
): Promise<PreviewSession> {
  const world = previewWorld(input.world ?? "app-web");
  const snapshot = await findSnapshot(input.gitSha, api, world);
  if (!snapshot) throw new Error("This commit has no Freestyle snapshot yet.");
  const minutes = input.lifetimeMinutes ?? 120;
  if (!Number.isInteger(minutes) || minutes < 10 || minutes > 1430) throw new Error("Preview lifetime must be 10–1430 minutes.");
  const launchId = randomUUID().replaceAll("-", "");
  const domain = `ow-${launchId}.preview.openwork.software`;
  const origins = world === "acme-web" ? {
    app: `https://${domain}`, den: `https://den-${launchId}.preview.openwork.software`, api: `https://api-${launchId}.preview.openwork.software`,
    engine: `https://engine-${launchId}.preview.openwork.software`, gateway: `https://gateway-${launchId}.preview.openwork.software`,
  } : undefined;
  const domains = origins ? Object.values(origins).map((value) => new URL(value).hostname) : [domain];
  const token = randomBytes(32).toString("base64url");
  const { vm, vmId, data } = await api.vms.create({
    snapshotId: snapshot.id, slug: `ow-preview-${launchId}`,
    displayName: `OpenWork preview ${input.gitSha.slice(0, 7)}`,
    ttlSeconds: minutes * 60, idleTimeoutSeconds: 600,
    metadata: { kind: PREVIEW_KIND, gitSha: input.gitSha, ...(input.reportId ? { reportId: input.reportId } : {}) },
    firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    // Inline rules share the VM lifecycle and disappear with its provider TTL.
    tls: { rules: domains.map((domain) => ({ action: "allow", domain, source: { public: true }, destination: { port: 8080 } })) },
  });
  let stage = "assign-access";
  try {
    const expiresAt = new Date(Date.parse(data.createdAt) + minutes * 60_000).toISOString();
    await vm.fs.writeTextFile(ACCESS_FILE, JSON.stringify({ token, expiresAt, origins, ...(origins ? { templateOrigins } : {}) }));
    await execChecked(vm, "chmod 600 /opt/openwork-preview/access.json");
    let outputs: PreviewOutputs = {};
    if (world === "acme-web") {
      // Processes, DB state, and compiled pages resume from CI's live snapshot.
      // This only renews the demo session and checks the restored services.
      stage = "resume-services";
      await execChecked(vm, "node /opt/openwork-preview/resume.mjs", 60_000);
      stage = "read-outputs";
      outputs = parsePreviewOutputs(JSON.parse(await vm.fs.readTextFile("/opt/openwork-preview/outputs.json")));
      const serviceKeys = { app: "webUrl", den: "denWeb", api: "denApi", engine: "openworkUrl", gateway: "gatewayUrl" };
      for (const [name, key] of Object.entries(serviceKeys)) {
        const origin = Object.entries(origins ?? {}).find(([service]) => service === name)?.[1];
        if (!origin) throw new Error("Missing private service origin");
        outputs[key] = { value: `${origin}/__openwork_launch?token=${token}`, secret: true, group: "Services", note: "Ready · open this link to authorize this service" };
      }
      outputs.previewCookie = { value: `__Host-openwork-preview=${token}`, secret: true, group: "Developer access", note: "Cookie header for requests to this VM's private service URLs" };
    } else {
      stage = "check-services";
      await execChecked(vm, "curl -fsS http://127.0.0.1:5178/ >/dev/null && node /opt/openwork-preview/health.mjs", 90_000);
    }
    const url = `https://${domain}/__openwork_launch?token=${token}`;
    stage = "public-access";
    await waitForPublicAccess(url, probe);
    return { id: vmId, snapshotId: snapshot.id, gitSha: input.gitSha, url, expiresAt, world, outputs };
  } catch (error) {
    await vm.delete().catch(() => undefined); // Provider TTL still bounds failed cleanup.
    throw new PreviewLaunchError(stage, vmId, error);
  }
}

export async function deletePreview(id: string, api = client()): Promise<void> {
  let vm;
  try { vm = await api.vms.get(id); }
  catch (error) { if (isMissing(error)) return; throw error; }
  if (vm.metadata.kind !== PREVIEW_KIND) throw new Error("Refusing to delete a VM not owned by OpenWork previews.");
  await api.vms.delete(vm.id);
}
