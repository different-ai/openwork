import { templateOrigins } from "./origins.mjs";
import { parsePreviewOutputs, type PreviewOutputs } from "./outputs.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
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

export type PreviewWorld = "app-web" | "acme-web" | "desktop";
export function previewWorld(value: unknown): PreviewWorld {
  if (value === "app-web" || value === "acme-web" || value === "desktop") return value;
  throw new Error("Unsupported preview world.");
}

export function snapshotSlug(sha: string, world: PreviewWorld = "app-web"): string {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed commit SHA is required.");
  return `openwork-${previewWorld(world)}-${world === "app-web" ? "v6" : "v7"}-${sha}`;
}

export function isMissing(error: unknown): boolean {
  return error instanceof FreestyleApiError && error.status === 404;
}

export async function findSnapshot(sha: string, api = client(), world: PreviewWorld = "app-web") {
  try { return await api.vms.snapshots.get(snapshotSlug(sha, world)); }
  catch (error) { if (isMissing(error)) return null; throw error; }
}

/** Freestyle reports a null status when it killed the command at `timeoutMs`; the guest may have finished its work. */
export function guestCommandOutcome(statusCode: number | null | undefined, timeoutMs: number): string {
  return typeof statusCode === "number" ? `exit ${statusCode}` : `killed at ${Math.round(timeoutMs / 1000)}s timeout`;
}

export async function execChecked(vm: Vm, command: string, timeoutMs = 120_000): Promise<string> {
  const result = await vm.exec({ command, timeoutMs, linuxUser: "root" });
  // Keep this prefix: the review app logs only messages that start with it.
  if (result.statusCode !== 0) throw new Error(`Freestyle guest command failed (${guestCommandOutcome(result.statusCode, timeoutMs)}).`);
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

/** The private gateway can answer before the restored app accepts its first request. */
export async function waitForPublicAccess(url: string, probe: typeof fetch = fetch, pause = delay, world: PreviewWorld = "app-web"): Promise<void> {
  let status = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const response = await probe(url, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
      status = response.status;
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      await response.body?.cancel();
      if (status === 303 && cookie?.startsWith("__Host-openwork-preview=")) {
        const page = await probe(new URL(world === "desktop" ? "/vnc.html" : "/", url), {
          headers: { cookie }, signal: AbortSignal.timeout(3_000),
        });
        status = page.status;
        const html = status === 200 ? await page.text() : "";
        if (status !== 200) await page.body?.cancel();
        if (status === 200 && html.includes(world === "desktop" ? "noVNC" : "OpenWork")) return;
        if (status === 200) status = 502; // A proxy warmup page is not the app.
      }
      if (![404, 408, 425, 429].includes(status) && status < 500) break;
    } catch (error) {
      if (!(error instanceof TypeError) && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
    }
    if (attempt < 7) await pause(250);
  }
  throw new Error(`Public sandbox readiness failed (HTTP ${status || "unreachable"}).`);
}

/**
 * Each advertised service hostname is a new edge route to this VM. A soak saw the
 * first Den API call 502 seconds after launch while the app hostname already
 * answered, so hand out no link before the gateway's own handshake answers on it.
 */
export async function waitForServiceRoutes(
  origins: Record<string, string>, token: string, probe: typeof fetch = fetch,
  pause: (ms: number) => Promise<unknown> = delay, deadlineMs = 20_000,
): Promise<void> {
  await Promise.all(Object.entries(origins).map(async ([service, origin]) => {
    const deadline = Date.now() + deadlineMs;
    let status = 0;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      try {
        const response = await probe(`${origin}/__openwork_launch?token=${token}`, { redirect: "manual", signal: AbortSignal.timeout(3_000) });
        status = response.status;
        const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
        await response.body?.cancel();
        if (status === 303 && cookie?.startsWith("__Host-openwork-preview=")) return;
        if (![404, 408, 425, 429].includes(status) && status < 500) break;
      } catch (error) {
        if (!(error instanceof TypeError) && !(error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) throw error;
      }
      await pause(Math.min(1_000, 250 * (attempt + 1)));
    }
    // Keep this prefix: the review app logs only messages that start with it.
    throw new Error(`Public sandbox readiness failed (HTTP ${status || "unreachable"}) for ${service}.`);
  }));
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
  const domain = `${world === "desktop" ? "desktop" : "ow"}-${launchId}.preview.openwork.software`;
  const origins = world === "acme-web" ? {
    app: `https://${domain}`, den: `https://den-${launchId}.preview.openwork.software`, api: `https://api-${launchId}.preview.openwork.software`,
    engine: `https://engine-${launchId}.preview.openwork.software`, gateway: `https://gateway-${launchId}.preview.openwork.software`,
    desktop: `https://desktop-${launchId}.preview.openwork.software`,
  } : world === "desktop" ? { desktop: `https://${domain}` } : undefined;
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
    await vm.fs.writeTextFile(ACCESS_FILE, JSON.stringify({ token, expiresAt, origins, ...(world === "acme-web" ? { templateOrigins } : {}) }), { mode: 0o600 });
    let outputs: PreviewOutputs = {};
    if (world === "acme-web") {
      // Den's demo session lasts 7 days; snapshots last at most 7 days and
      // sandboxes at most 23h50m. A snapshot younger than 5 days has enough
      // session lifetime left for every allowed sandbox, even after warmup.
      // CI already checks the complete running world before taking the snapshot.
      const age = Date.now() - Date.parse(snapshot.createdAt);
      if (!Number.isFinite(age) || age < 0 || age >= 5 * 24 * 60 * 60_000) {
        stage = "resume-services";
        // Older v4 snapshots may contain the previous renewal script, which
        // only rotated already-expired sessions. Refresh it before reuse.
        await vm.fs.writeTextFile("/opt/openwork-preview/resume.mjs", await readFile(new URL("./resume.mjs", import.meta.url), "utf8"), { mode: 0o600 });
        await execChecked(vm, "node /opt/openwork-preview/resume.mjs", 60_000);
      }
      stage = "read-outputs";
      outputs = parsePreviewOutputs(JSON.parse(await vm.fs.readTextFile("/opt/openwork-preview/outputs.json")));
      const serviceKeys: Record<string, string> = { app: "webUrl", den: "denWeb", api: "denApi", engine: "openworkUrl", gateway: "gatewayUrl" };
      // Link the noVNC viewer only when this snapshot started the desktop display.
      if (outputs.desktopStatus && outputs.desktopStatus.value !== "unavailable") serviceKeys.desktop = "desktopUrl";
      for (const [name, key] of Object.entries(serviceKeys)) {
        const origin = Object.entries(origins ?? {}).find(([service]) => service === name)?.[1];
        if (!origin) throw new Error("Missing private service origin");
        outputs[key] = { value: `${origin}/__openwork_launch?token=${token}`, secret: true, group: "Services", note: "Ready · open this link to authorize this service" };
      }
      outputs.previewCookie = { value: `__Host-openwork-preview=${token}`, secret: true, group: "Developer access", note: "Cookie header for requests to this VM's private service URLs" };
    }
    const url = `https://${domain}/__openwork_launch?token=${token}`;
    if (world === "desktop") {
      stage = "desktop-ready";
      if ((await vm.fs.readTextFile("/opt/openwork-preview/source-sha")).trim() !== input.gitSha
        || (await vm.fs.readTextFile("/opt/openwork-preview/desktop/status")).trim() !== "ready-signed-out") {
        throw new Error("Desktop snapshot is not ready at the requested commit");
      }
      const saved = parsePreviewOutputs(JSON.parse(await vm.fs.readTextFile("/opt/openwork-preview/outputs.json")));
      if (Object.keys(saved).length !== 1 || saved.desktopStatus?.value !== "ready-signed-out") {
        throw new Error("Invalid desktop-only snapshot outputs");
      }
      outputs = {
        desktopStatus: saved.desktopStatus,
        desktopUrl: { value: url, secret: true, group: "Services", note: "Ready · private desktop viewer" },
        previewCookie: { value: `__Host-openwork-preview=${token}`, secret: true, group: "Developer access", note: "Cookie header for this desktop viewer only" },
      };
    }
    stage = "public-access";
    await waitForPublicAccess(url, probe, delay, world);
    if (world === "acme-web" && origins) {
      stage = "service-routes";
      // The app hostname was checked above; every other linked service must route too.
      const linked = Object.fromEntries(Object.entries(origins).filter(([service]) => service !== "app" && (service !== "desktop" || outputs.desktopUrl)));
      await waitForServiceRoutes(linked, token, probe);
    }
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
