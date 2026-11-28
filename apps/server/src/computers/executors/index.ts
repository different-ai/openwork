import type { SandboxProvider } from "@openwork/sandbox";
import type { ComputerAuthorizeResponse, ComputerGrantScope, ComputerToolCall } from "@openwork/types/den/computers";
import type { SandboxToolResult } from "../../sandbox-tool-host.js";
import type { ComputerSourceQueue } from "../den.js";
import { computerCannotTakeWork } from "../messages.js";
import { queueExecutor } from "./queue.js";
import { sandboxExecutor, type SandboxExecutorAdapter } from "./sandbox.js";

export type ComputerExecutorRequest = {
  id: string;
  label: string;
  call: ComputerToolCall;
  signal: AbortSignal;
  connection?: ComputerAuthorizeResponse["connection"];
  scope?: ComputerGrantScope | null;
};
export type ComputerExecutorDeps = {
  env?: NodeJS.ProcessEnv;
  providerFactory?: (adapter: SandboxExecutorAdapter, apiKey: string, env: NodeJS.ProcessEnv) => Promise<SandboxProvider>;
  queue?: ComputerSourceQueue | null;
};
export interface ComputerExecutor {
  run(request: ComputerExecutorRequest, deps: ComputerExecutorDeps): Promise<SandboxToolResult>;
}

const executors = new Map<string, ComputerExecutor>([
  ["daytona", sandboxExecutor({
    name: "Daytona", key: "DAYTONA_API_KEY", ref: sandboxId => ({ sandboxId }),
    async create(apiKey, env) {
      const { createDaytonaProvider } = await import("@openwork/sandbox-daytona");
      return createDaytonaProvider({
        apiKey, apiUrl: env.DAYTONA_API_URL?.trim() || "https://app.daytona.io/api", target: env.DAYTONA_TARGET?.trim() || undefined,
        snapshot: null, image: "", resources: { cpu: 1, memoryGb: 1, diskGb: 1 },
        pollIntervalMs: 1_000, helperCreateTimeoutMs: 60_000, platform: { os: "linux", isolation: "container" },
      });
    },
  })],
  ["freestyle", sandboxExecutor({
    name: "Freestyle", key: "FREESTYLE_API_KEY", ref: vmId => ({ vmId }),
    async create(apiKey) {
      const { createFreestyleProvider } = await import("@openwork/sandbox-freestyle");
      return createFreestyleProvider({ apiKey, snapshot: "", firewall: { rules: [] } });
    },
  })],
  ["openwork_desktop", queueExecutor],
]);
const unsupported: ComputerExecutor = { async run({ label }) { throw new Error(computerCannotTakeWork(label)); } };
export const computerExecutor = (provider: string): ComputerExecutor => executors.get(provider) ?? unsupported;
