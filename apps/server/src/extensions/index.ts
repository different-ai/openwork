import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import type { ServerConfig } from "../types.js";
import {
  callGoogleWorkspaceExtensionAction,
  GOOGLE_WORKSPACE_EXTENSION_ACTIONS,
  GOOGLE_WORKSPACE_EXTENSION_ID,
} from "./google-workspace.js";
import {
  callOpenAiImageGenerationExtensionAction,
  OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS,
  OPENAI_IMAGE_GENERATION_EXTENSION_ID,
} from "./openai-image-generation.js";

const OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS = [
  ...GOOGLE_WORKSPACE_EXTENSION_ACTIONS,
  ...OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

export function listExperimentalExtensionActions(extensionId: string) {
  const filter = extensionId.trim();
  return filter
    ? OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS.filter((action) => action.extensionId === filter)
    : OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS;
}

export async function callExperimentalExtensionAction(config: ServerConfig, env: EnvService, input: unknown) {
  if (!isRecord(input)) {
    throw new ApiError(400, "invalid_payload", "Expected extension action call payload");
  }
  const extensionId = readStringField(input, "extensionId");
  const action = readStringField(input, "action");
  const args = isRecord(input.args) ? input.args : {};
  const context = isRecord(input.context) ? input.context : {};
  if (!extensionId || !action) {
    throw new ApiError(400, "invalid_payload", "extensionId and action are required");
  }
  const registered = OPENWORK_EXPERIMENTAL_EXTENSION_ACTIONS.find((item) => item.extensionId === extensionId && item.action === action);
  if (!registered) {
    throw new ApiError(404, "extension_action_not_found", "OpenWork extension action not found");
  }

  if (extensionId === GOOGLE_WORKSPACE_EXTENSION_ID) {
    const result = await callGoogleWorkspaceExtensionAction(config, action, args, context);
    if (result) return result;
  }

  if (extensionId === OPENAI_IMAGE_GENERATION_EXTENSION_ID) {
    const result = await callOpenAiImageGenerationExtensionAction(config, env, action, args, context);
    if (result) return result;
  }

  throw new ApiError(501, "extension_action_not_implemented", `${registered.title} is registered but not implemented on openwork-server yet.`, { extensionId, action, args });
}
