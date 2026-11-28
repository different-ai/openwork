import { join } from "node:path";
import { computerAuthorizeResponseSchema, computerListResponseSchema } from "@openwork/types/den/computers";
import { computerExecutor } from "../../src/computers/executors/index.js";
import { createComputerService } from "../../src/computers/service.js";
import { createLocalSandboxRuntime } from "../../src/local-sandbox-runtime.js";
import { createSandboxToolsBridge } from "../../src/sandbox-tools-bridge.js";
import type { ServerConfig } from "../../src/types.js";

export function computersFixture(directory: string, root = directory): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, token: "client-fixture", hostToken: "host-fixture", approval: { mode: "auto", timeoutMs: 1000 },
    configPath: join(root, "runtime", "server.json"), corsOrigins: [], authorizedRoots: [directory], workspaces: [], readOnly: false,
    startedAt: 0, tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
}

export async function computerBridgeFixture(config: ServerConfig, personal = false) {
  const computer = (id: string, label: string) => computerAuthorizeResponseSchema.parse({
    decision: { outcome: "allow", route: "checked", scope: { surface: "whole_vm", folders: ["/workspace"] } },
    computer: {
      id, label, kind: "registered_vm", provider: "daytona", availability: "online", state: "ready", ownerMemberId: "fixture-owner",
      lastSeenAt: null, access: null, reach: { outcome: "allow", route: "checked", scope: { surface: "whole_vm", folders: ["/workspace"] } },
    },
    connection: { provider: "daytona", externalId: id },
  });
  const buildBox = computer("build-box", "Build box");
  const secondBox = computer("second-box", "Second box");
  const personalComputers = computerListResponseSchema.parse({ computers: [buildBox.computer, secondBox.computer].map(target => ({
    ...target, kind: "member_machine", provider: "openwork_desktop", state: "online",
    reach: { outcome: "allow", route: "checked", scope: { surface: "sandbox", folders: ["/workspace", "/records"], writableFolders: ["/workspace"] } },
  })) }).computers;
  const dispatched: unknown[] = [];
  const service = createComputerService(config, {
    async status() { return "enabled"; },
    async listComputers() { return { status: "enabled", computers: personal ? personalComputers : [buildBox.computer, secondBox.computer] }; },
    async authorize(id) {
      if (personal) throw new Error("Personal computers must use the queue, not authorize");
      return id === buildBox.computer.id ? buildBox : secondBox;
    },
    sourceQueue: () => personal ? {
      async enqueue(_id, call) {
        dispatched.push(call.input);
        return { state: "done", id: "cmd", output: "remote shell ran", exitCode: 0, truncated: false };
      },
      async follow() { throw new Error("Done commands never need a follow"); },
    } : null,
  }, provider => provider === "daytona" ? { async run({ call }) {
    dispatched.push(call.input);
    return { content: [{ type: "text", text: "remote shell ran" }], metadata: { sandbox: true, truncated: false, exitCode: 0 } };
  } } : computerExecutor(provider));
  const runtime = createLocalSandboxRuntime(config, { settings: async () => ({ useSandbox: false, forceSandbox: false }) });
  const bridge = await createSandboxToolsBridge(config, runtime, service);
  const close = async () => { await bridge.close(); await runtime.close(); };
  return { bridge, service, dispatched, close };
}
