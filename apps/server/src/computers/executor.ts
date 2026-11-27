import { setTimeout as delay } from "node:timers/promises";
import { insideSharedFolder, refusal } from "@openwork/computers";
import type { SandboxProvider } from "@openwork/sandbox";
import type { ComputerAuthorizeResponse, ComputerGrantScope } from "@openwork/types/den/computers";
import { createSandboxToolHost, type SandboxToolName } from "../sandbox-tool-host.js";
import { computerActionForTool, translateComputerInput } from "./input.js";

type DaytonaConfig = { apiKey: string; apiUrl: string; target?: string };
type ComputerRun = {
  connection: NonNullable<ComputerAuthorizeResponse["connection"]>;
  scope: ComputerGrantScope;
  label: string;
  tool: SandboxToolName;
  input: unknown;
  translated?: unknown;
  signal: AbortSignal;
};

async function createProvider(config: DaytonaConfig) {
  const { createDaytonaProvider } = await import("@openwork/sandbox-daytona");
  return createDaytonaProvider({
    ...config, snapshot: null, image: "", resources: { cpu: 1, memoryGb: 1, diskGb: 1 },
    pollIntervalMs: 1_000, helperCreateTimeoutMs: 60_000, platform: { os: "linux", isolation: "container" },
  });
}

export async function runOnComputer(
  { connection, scope, label, tool, input, translated: authorizedInput, signal }: ComputerRun,
  { env = process.env, providerFactory = createProvider }: {
    env?: NodeJS.ProcessEnv;
    providerFactory?: (config: DaytonaConfig) => Promise<SandboxProvider>;
  } = {},
) {
  const folder = scope.folders[0];
  if (!folder) throw new Error(`I can't use ${label}. No folders are shared with me.`);
  const translated = authorizedInput ?? translateComputerInput(tool, input, folder);
  const action = computerActionForTool(tool, translated);
  const path = action.type === "shell" ? action.cwd : action.path;
  if (!path || !insideSharedFolder(path, scope.folders)) throw new Error(refusal("folder_not_shared", { label }, action).message);
  if (connection.provider !== "daytona") throw new Error(`OpenWork can't reach ${connection.provider} computers yet.`);
  const apiKey = env.DAYTONA_API_KEY?.trim();
  if (!apiKey) throw new Error("This computer needs its Daytona key on this machine before OpenWork can reach it.");
  signal.throwIfAborted();
  const unavailable = () => new Error(`OpenWork couldn't reach ${label} or finish that operation there.`);
  const missing = () => new Error(`${label} no longer exists at its provider.`);
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  const byDeadline = async <T>(operation: Promise<T>): Promise<T> => {
    deadline.throwIfAborted();
    let abort = () => {};
    const cancel = new Promise<never>((_, reject) => {
      abort = () => reject(unavailable());
      deadline.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([operation, cancel]); }
    catch { throw unavailable(); }
    finally { deadline.removeEventListener("abort", abort); }
  };
  const provider = await byDeadline(providerFactory({ apiKey, apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api", target: env.DAYTONA_TARGET?.trim() || undefined }));
  const acquire = async () => {
    let handle = await byDeadline(provider.get({ providerId: provider.id, ref: { sandboxId: connection.externalId } }));
    if (!handle || handle.state === "missing") throw missing();
    if (handle.state === "stopped" || handle.state === "archived") {
      await byDeadline(provider.start(handle, { timeoutMs: 90_000 }));
      handle = await byDeadline(provider.inspect(handle));
    }
    while (handle.state !== "running") {
      if (handle.state === "missing") throw missing();
      if (handle.state === "error") throw new Error(`${label} has a problem at its provider.`);
      await delay(500, undefined, { signal: deadline }).catch(() => { throw unavailable(); });
      handle = await byDeadline(provider.inspect(handle));
    }
    return handle;
  };
  const handle = await acquire();
  const host = createSandboxToolHost({ provider, acquire: async () => handle, cwd: folder });
  try {
    const result = await host.execute(tool, translated, { sessionID: "", signal });
    return { ...result, content: result.content.map(part => ({ ...part, text: part.text.replaceAll(apiKey, "[redacted]") })) };
  } catch {
    throw unavailable();
  }
}
