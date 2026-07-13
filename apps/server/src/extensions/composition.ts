import {
  googleWorkspaceConnectGuidance,
  googleWorkspaceStatusConnectExtra,
  shouldGateLegacyGoogleWorkspace,
} from "../connect-state.js";
import type { EnvService } from "../env-file.js";
import type { ServerConfig } from "../types.js";
import type { ExtensionActionService } from "./action-contract.js";
import { createExtensionActionRegistry } from "./action-registry.js";
import { createExtensionActionService } from "./action-service.js";
import { createGoogleWorkspaceActionContributions } from "./google-workspace-actions.js";
import { createGoogleWorkspaceActionOperations } from "./google-workspace.js";
import { createOpenAiImageGenerationActionContributions } from "./openai-image-generation-actions.js";
import { createOpenAiImageGenerationActionOperations } from "./openai-image-generation.js";

export function createServerExtensionActionService(config: ServerConfig, env: EnvService): ExtensionActionService {
  const googleWorkspace = createGoogleWorkspaceActionContributions(
    createGoogleWorkspaceActionOperations(config),
    {
      isGated: shouldGateLegacyGoogleWorkspace,
      guidance: (snapshot) => googleWorkspaceConnectGuidance(snapshot.cloudMcpPresent),
      statusExtra: googleWorkspaceStatusConnectExtra,
    },
  );
  const openAiImageGeneration = createOpenAiImageGenerationActionContributions(
    createOpenAiImageGenerationActionOperations(config, env),
  );
  const registry = createExtensionActionRegistry([
    ...googleWorkspace,
    ...openAiImageGeneration,
  ]);
  return createExtensionActionService(registry);
}
