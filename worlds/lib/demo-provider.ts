import { setTimeout as delay } from "node:timers/promises";
import { daytonaSandboxLimitArgs, defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import type { DaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { deleteSandboxes, execInSandbox } from "../../evals/packages/hosts/src/provision.ts";
import { privateSandboxId, privateWebPreview } from "../../evals/packages/hosts/src/private-web-preview.ts";
import { verifyViewer } from "./private-viewer.ts";
import { idPattern, isRecord } from "./demo-snapshot.ts";

export async function demoCli(args: string[], context: string, timeoutMs = 30_000, exec: DaytonaExec = defaultDaytonaExec): Promise<string> {
  try {
    const result = await exec(args, { timeoutMs });
    if (result.code === 0) return result.stdout;
  } catch { /* Do not log provider output or command arguments. */ }
  throw new Error(`${context} failed; no provider output logged.`);
}

export async function demoGuest(id: string, script: string, context: string, timeoutMs = 90_000): Promise<string> {
  try {
    return (await execInSandbox(defaultDaytonaExec, id, `printf %s ${Buffer.from(script).toString("base64")} | base64 -d | bash`, { context, timeoutMs })).stdout;
  } catch { throw new Error(`${context} failed; no guest output logged.`); }
}

/** Use the reviewed immutable ID, not the reusable name. No env or secrets mounts. */
export async function createDemoSandbox(name: string, snapshot: string, ttlMinutes: number, exec: DaytonaExec = defaultDaytonaExec) {
  if (!idPattern.test(snapshot) || !idPattern.test(name)) throw new Error("Missing immutable snapshot ID or unique sandbox name.");
  await demoCli(["create", "--name", name, "--snapshot", snapshot, "--target", "us", "--auto-stop", "0",
    ...daytonaSandboxLimitArgs({ ttlMinutes })], "Create private Daytona sandbox", 300_000, exec);
  let id: string;
  try { id = await privateSandboxId(name, exec); }
  catch { throw new Error("Could not confirm sandbox privacy or identity."); }
  if (!idPattern.test(id)) throw new Error("Could not confirm sandbox UUID.");
  return id;
}

export async function deleteDemoSandbox(id: string, exec: DaytonaExec = defaultDaytonaExec) {
  try {
    if (!idPattern.test(id)) throw new Error("Invalid sandbox receipt.");
    // A pending create has only its random name journaled. Resolve it before delete.
    const info: unknown = JSON.parse(await demoCli(["info", id, "-f", "json"], "Resolve owned sandbox", 30_000, exec));
    if (!isRecord(info) || (info.id !== id && info.name !== id) || info.public !== false
      || typeof info.id !== "string" || !idPattern.test(info.id)) throw new Error("Invalid identity.");
    await deleteSandboxes([info.id], { exec, log: () => {} });
  } catch { throw new Error("Daytona deletion could not be confirmed; retry cleanup or rely on the provider TTL."); }
}

export async function demoSandboxInfo(id: string): Promise<{ state: string; createdAt: string }> {
  const data: unknown = JSON.parse(await demoCli(["info", id, "-f", "json"], "Read sandbox status"));
  if (!isRecord(data) || data.id !== id || data.public !== false || typeof data.state !== "string"
    || typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) throw new Error("Invalid private sandbox status.");
  return { state: data.state, createdAt: data.createdAt };
}

export async function waitForDemoGuest(id: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await demoGuest(id, "test \"$(id -un)\" = daytona && DISPLAY=:99 xset q >/dev/null", "Wait for desktop", 8_000).then(() => true, () => false)) return;
    await delay(1_500);
  }
  throw new Error("The Daytona desktop was not ready.");
}

export async function demoCdpReachable(id: string): Promise<boolean> {
  return demoGuest(id, "curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:9223/json/version >/dev/null", "Check guest CDP", 8_000).then(() => true, () => false);
}

export async function mintDemoViewer(id: string, expiresAt: string) {
  const now = Date.now();
  const seconds = Math.min(3600, Math.floor((Date.parse(expiresAt) - now) / 1000));
  if (seconds < 1) throw new Error("Sandbox lifetime has expired; launch a new stage.");
  try {
    const { browserOrigin } = await privateWebPreview(id, 6080, defaultDaytonaExec, seconds);
    const viewer = `${browserOrigin}/vnc.html?autoconnect=1&resize=scale&view_only=0&reconnect=1&reconnect_delay=2000`;
    await verifyViewer(viewer, id);
    return { viewer, viewerExpiresAt: new Date(now + seconds * 1000).toISOString() };
  } catch { throw new Error("Could not verify the signed private noVNC viewer. No URL published."); }
}
