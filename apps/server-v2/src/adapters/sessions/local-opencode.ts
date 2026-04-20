import { RouteError } from "../../http.js";
import type { RuntimeService } from "../../services/runtime-service.js";
import type { WorkspaceRecord } from "../../database/types.js";
import { createOpenCodeSessionBackend } from "./opencode-backend.js";

export function createLocalOpencodeSessionAdapter(input: {
  runtime: RuntimeService;
  workspace: WorkspaceRecord;
}) {
  const runtimeHealth = input.runtime.getOpencodeHealth();
  if (!runtimeHealth.baseUrl || !runtimeHealth.running) {
    throw new RouteError(
      503,
      "service_unavailable",
      "Local OpenCode runtime is not available for session operations.",
    );
  }

  return createOpenCodeSessionBackend({
    baseUrl: runtimeHealth.baseUrl,
    directory: input.workspace.dataDir,
  });
}
