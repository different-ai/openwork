import { setTimeout as delay } from "node:timers/promises";
import type { SandboxProvider } from "@openwork/sandbox";
import { computerWholeVmScopeSchema, type ComputerAuthorizeResponse, type ComputerGrantScope } from "@openwork/types/den/computers";
import { createSandboxToolHost, SandboxToolError, type SandboxToolName } from "../sandbox-tool-host.js";
import { computerActionForTool, translateComputerInput } from "./input.js";
import { computerCannotTakeWork, computerMissing, computerNeedsDaytonaKey, computerOutcomeUnknown, computerProviderProblem, computerUnreachable } from "./messages.js";

type DaytonaConfig = { apiKey: string; apiUrl: string; target?: string };
type ComputerRun = {
  connection: NonNullable<ComputerAuthorizeResponse["connection"]>;
  scope: ComputerGrantScope | null | undefined;
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

async function untilAborted<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([run(), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

export async function runOnComputer(
  { connection, scope, label, tool, input, translated: authorizedInput, signal }: ComputerRun,
  { env = process.env, providerFactory = createProvider }: {
    env?: NodeJS.ProcessEnv;
    providerFactory?: (config: DaytonaConfig) => Promise<SandboxProvider>;
  } = {},
) {
  const consent = computerWholeVmScopeSchema.safeParse(scope);
  const folder = consent.data?.folders[0];
  if (!folder) throw new Error(`I can't use ${label} without its owner's approval to access the entire computer.`);
  const translated = authorizedInput ?? translateComputerInput(tool, input, folder);
  computerActionForTool(tool, translated);
  if (connection.provider !== "daytona") throw new Error(computerCannotTakeWork(label));
  const apiKey = env.DAYTONA_API_KEY?.trim();
  if (!apiKey) throw new Error(computerNeedsDaytonaKey(label));
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  const acquire = async () => {
    const provider = await providerFactory({ apiKey, apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api", target: env.DAYTONA_TARGET?.trim() || undefined });
    deadline.throwIfAborted();
    let handle = await provider.get({ providerId: provider.id, ref: { sandboxId: connection.externalId } });
    deadline.throwIfAborted();
    if (handle?.state === "stopped" || handle?.state === "archived") {
      await provider.start(handle, { timeoutMs: 90_000 });
      deadline.throwIfAborted();
      handle = await provider.inspect(handle);
    }
    while (handle?.state !== "running") {
      if (!handle || handle.state === "missing") return computerMissing(label);
      if (handle.state === "error") return computerProviderProblem(label);
      await delay(500, undefined, { signal: deadline });
      handle = await provider.inspect(handle);
    }
    return { provider, handle };
  };
  const acquired = await untilAborted(deadline, acquire).catch(() => { throw new Error(computerUnreachable(label)); });
  if (typeof acquired === "string") throw new Error(acquired);
  const { provider, handle } = acquired;
  const host = createSandboxToolHost({ provider, acquire: async () => handle, cwd: folder, computerTools: true });
  const execution = AbortSignal.any([signal, AbortSignal.timeout(125_000)]);
  if (execution.aborted) throw new Error(computerUnreachable(label));
  try {
    const result = await untilAborted(execution, () => host.execute(tool, translated, { sessionID: "", signal: execution }));
    return { ...result, content: result.content.map(part => ({ ...part, text: part.text.replaceAll(apiKey, "[redacted]") })) };
  } catch (error) {
    if (error instanceof SandboxToolError) throw new Error(error.message.replaceAll(apiKey, "[redacted]"));
    throw new Error(computerOutcomeUnknown(label, signal.aborted));
  }
}
