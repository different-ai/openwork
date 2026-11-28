import { setTimeout as delay } from "node:timers/promises";
import type { SandboxProvider, SandboxRef } from "@openwork/sandbox";
import { computerWholeVmScopeSchema } from "@openwork/types/den/computers";
import { createSandboxToolHost, SandboxToolError } from "../../sandbox-tool-host.js";
import { computerMissing, computerOutcomeUnknown, computerProviderProblem, computerUnreachable } from "../messages.js";
import type { ComputerExecutor } from "./index.js";

export type SandboxExecutorAdapter = {
  name: string;
  key: string;
  ref(id: string): SandboxRef["ref"];
  create(apiKey: string, env: NodeJS.ProcessEnv): Promise<SandboxProvider>;
};

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

export function sandboxExecutor(adapter: SandboxExecutorAdapter): ComputerExecutor {
  return { async run({ connection, scope, label, call, signal }, { env = process.env, providerFactory }) {
    const consent = computerWholeVmScopeSchema.safeParse(scope);
    const folder = consent.data?.folders[0];
    if (!folder) throw new Error(`I can't use ${label} without its owner's approval to access the entire computer.`);
    if (!connection) throw new Error(computerUnreachable(label));
    const apiKey = env[adapter.key]?.trim();
    if (!apiKey) throw new Error(`${label} needs its ${adapter.name} key on this machine before OpenWork can reach it. Nothing ran there.`);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    const acquire = async () => {
      const provider = await (providerFactory ? providerFactory(adapter, apiKey, env) : adapter.create(apiKey, env));
      deadline.throwIfAborted();
      let handle = await provider.get({ providerId: provider.id, ref: adapter.ref(connection.externalId) });
      deadline.throwIfAborted();
      if (handle?.state === "stopped" || handle?.state === "archived") {
        await provider.start(handle, { timeoutMs: 90_000 });
        deadline.throwIfAborted();
        handle = await provider.inspect(handle);
      }
      while (handle?.state !== "running") {
        if (!handle || handle.state === "missing") return computerMissing(label, adapter.name);
        if (handle.state === "error") return computerProviderProblem(label, adapter.name);
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
      const result = await untilAborted(execution, () => host.execute(call.tool, call.input, { sessionID: "", signal: execution }));
      return { ...result, content: result.content.map(part => ({ ...part, text: part.text.replaceAll(apiKey, "[redacted]") })) };
    } catch (error) {
      if (error instanceof SandboxToolError) throw new Error(error.message.replaceAll(apiKey, "[redacted]"));
      throw new Error(computerOutcomeUnknown(label, signal.aborted));
    }
  } };
}
