/** Compatibility edge for existing world bootstrap recipes, backed by the shared sandbox primitives.
 * Only preview-workbot selects it. Snapshot inventory remains CLI-native; runtime lifecycle is shared.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createDaytonaClient, createDaytonaProvider, type DaytonaProviderConfig } from "@openwork/sandbox-daytona";
import { shellQuote, withBlocks, type SandboxHandle, type SandboxProvider } from "@openwork/sandbox";
import { defaultDaytonaExec, type DaytonaExec } from "./daytona.ts";

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
type Auth = { mode: "api-key"; apiKey: string; apiUrl: string } | { mode: "cli" };

/** Same identity as the CLI: scoped key+URL, otherwise the active saved profile. Never changes login. */
export async function worldDaytonaAuth(env: NodeJS.ProcessEnv = process.env, read: (path: string, encoding: "utf8") => Promise<string> = readFile): Promise<Auth> {
  if (env.DAYTONA_API_KEY && env.DAYTONA_API_URL) return { mode: "api-key", apiKey: env.DAYTONA_API_KEY, apiUrl: env.DAYTONA_API_URL };
  const dir = env.DAYTONA_CONFIG_DIR ?? (process.platform === "darwin" ? join(homedir(), "Library", "Application Support", "daytona") : join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "daytona"));
  let parsed: unknown;
  try { parsed = JSON.parse(await read(join(dir, "config.json"), "utf8")); } catch { throw new Error("Missing or invalid Daytona CLI profile; run daytona login"); }
  if (!record(parsed) || !Array.isArray(parsed.profiles)) throw new Error("Invalid Daytona CLI profile; run daytona login");
  const profile = parsed.profiles.find((p: unknown) => record(p) && (p.id === parsed.activeProfile || p.name === parsed.activeProfile));
  if (!record(profile) || !record(profile.api) || !text(profile.api.url)) throw new Error("No active Daytona CLI profile; run daytona login");
  const apiUrl = text(profile.api.url);
  if (!apiUrl) throw new Error("Daytona profile is missing its API URL");
  const apiKey = text(profile.api.key);
  if (apiKey) return { mode: "api-key", apiKey, apiUrl };
  // Browser profiles need the CLI's refresh/session machinery. Keep that
  // transport rather than copying tokens into a second, non-refreshing client.
  return { mode: "cli" };
}

export type DaytonaWorldInfo = { id: string; name?: string; public?: boolean; toolboxProxyUrl?: string };
export function sharedDaytonaExec(provider: SandboxProvider, info: (id: string) => Promise<DaytonaWorldInfo>, snapshots: DaytonaExec = defaultDaytonaExec): DaytonaExec {
  const { run } = withBlocks(provider, ["run"], "Linux world");
  const owned = new Set<string>();
  const box = async (id: string): Promise<SandboxHandle> => {
    const h = await provider.get({ providerId: provider.id, ref: { sandboxId: id } });
    if (!h) throw new Error("World sandbox not found");
    return h;
  };
  const value = (args: string[], flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  return async (args, opts = {}) => {
    const timeout = { timeoutMs: opts.timeoutMs ?? 60_000 };
    // Do not convert unknown/timeout outcomes into retryable CLI text. Throw
    // directly so checkedExec cannot repeat a possibly executed command.
    if (args[0] === "exec") {
      const separator = args.indexOf("--");
      if (separator !== 2 || args.length <= 3 || opts.input) throw new Error("Unsupported world exec shape");
      const command = args.length === 4 ? args[3] : args.slice(3).map(shellQuote).join(" ");
      const result = await run(await box(args[1]), { ...timeout, command });
      return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    }
    if (args[0] === "create") {
      const name = value(args, "--name"), snapshot = value(args, "--snapshot");
      if (!name || !snapshot || args.includes("--volume")) throw new Error("Linux preview requires a snapshot/name and no secrets volume");
      const known = new Set(["--name", "--snapshot", "--auto-stop", "--target", "--public"]);
      for (let i = 1; i < args.length; i++) { if (!known.has(args[i])) throw new Error(`Unsupported sandbox option ${args[i]}`); if (args[i] !== "--public") i++; }
      const target = value(args, "--target");
      if (target && !provider.describe().regions.includes(target)) throw new Error("World target differs from configured provider target");
      const minutes = Number(value(args, "--auto-stop") ?? 60);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw new Error("Invalid auto-stop minutes");
      const h = await provider.create({ idempotencyKey: name, image: { id: snapshot, version: snapshot }, env: {}, labels: { "openwork.sandbox.scope": name, "openwork.world": "preview-workbot" }, storage: [], exposePorts: [], public: args.includes("--public"), lifecycle: { autoStopMinutes: minutes, autoDeleteMinutes: 180 } }, timeout);
      owned.add(name); owned.add(h.ref.ref.sandboxId);
      return { code: 0, stdout: h.ref.ref.sandboxId, stderr: "" };
    }
    if (args[0] === "info") return { code: 0, stdout: JSON.stringify(await info(args[1])), stderr: "" };
    if (args[0] === "preview-url") {
      const endpoint = await provider.endpoint(await box(args[1]), Number(value(args, "-p")), { ttlSeconds: Number(value(args, "--expires") ?? 3600) });
      return { code: 0, stdout: endpoint.url, stderr: "" };
    }
    if (args[0] === "delete") {
      if (!owned.has(args[1])) throw new Error("Refusing to delete a sandbox not created by this world");
      const h = await provider.get({ providerId: provider.id, ref: { sandboxId: args[1] } });
      if (h) await provider.destroy(h, timeout);
      return { code: 0, stdout: "deleted", stderr: "" };
    }
    if (args[0] === "sandbox" && args[1] === "start") { await provider.start(await box(args[2]), timeout); return { code: 0, stdout: "started", stderr: "" }; }
    if (args[0] === "snapshot" && args[1] === "list") return snapshots(args, opts);
    throw new Error(`Unsupported world operation ${args[0]}; use its provider-native tool explicitly`);
  };
}

export async function createWorldDaytonaExec(): Promise<DaytonaExec> {
  const auth = await worldDaytonaAuth();
  if (auth.mode === "cli") return defaultDaytonaExec;
  const config: DaytonaProviderConfig = { ...auth, target: "us", snapshot: null, image: "node:20-bookworm", resources: { cpu: 2, memoryGb: 4, diskGb: 8 }, pollIntervalMs: 100, helperCreateTimeoutMs: 120_000, platform: { os: "linux", isolation: "container" } };
  const client = createDaytonaClient(config);
  const provider = createDaytonaProvider(config, { client });
  return sharedDaytonaExec(provider, async id => {
    const sandbox = await client.get(id);
    await sandbox.refreshData();
    return { id: sandbox.id, name: sandbox.name, public: sandbox.public, toolboxProxyUrl: sandbox.toolboxProxyUrl };
  });
}
