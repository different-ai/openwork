import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import {
  googleWorkspaceConnectGuidance,
  googleWorkspaceStatusConnectExtra,
  shouldGateLegacyGoogleWorkspace,
  type ConnectSnapshot,
} from "../connect-state.js";
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
import {
  callMicxCloudUploadAction,
  MICX_CLOUD_UPLOAD_ACTIONS,
  MICX_CLOUD_UPLOADS_EXTENSION_ID,
} from "./cloud-uploads.js";

const MICX_EXPERIMENTAL_EXTENSION_ACTIONS = [
  ...GOOGLE_WORKSPACE_EXTENSION_ACTIONS,
  ...OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS,
  ...MICX_CLOUD_UPLOAD_ACTIONS,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

export function listExperimentalExtensionActions(extensionId: string, connectSnapshot?: ConnectSnapshot) {
  const filter = extensionId.trim();
  const actions = filter
    ? MICX_EXPERIMENTAL_EXTENSION_ACTIONS.filter((action) => action.extensionId === filter)
    : MICX_EXPERIMENTAL_EXTENSION_ACTIONS;
  if (!connectSnapshot || !shouldGateLegacyGoogleWorkspace(connectSnapshot)) return actions;
  return actions.filter((action) => action.extensionId !== GOOGLE_WORKSPACE_EXTENSION_ID || action.action === "status");
}

export async function callExperimentalExtensionAction(config: ServerConfig, env: EnvService, input: unknown, connectSnapshot?: ConnectSnapshot) {
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
  const registered = MICX_EXPERIMENTAL_EXTENSION_ACTIONS.find((item) => item.extensionId === extensionId && item.action === action);
  if (!registered) {
    throw new ApiError(404, "extension_action_not_found", "Micx extension action not found");
  }

  if (
    extensionId === GOOGLE_WORKSPACE_EXTENSION_ID &&
    action !== "status" &&
    connectSnapshot &&
    shouldGateLegacyGoogleWorkspace(connectSnapshot)
  ) {
    return {
      ok: false,
      error: "use_micx_cloud",
      message: googleWorkspaceConnectGuidance(connectSnapshot.cloudHealth),
    };
  }

  if (extensionId === GOOGLE_WORKSPACE_EXTENSION_ID) {
    const result = await callGoogleWorkspaceExtensionAction(config, action, args, context, connectSnapshot ? googleWorkspaceStatusConnectExtra(connectSnapshot) : {});
    if (result) return result;
  }

  if (extensionId === OPENAI_IMAGE_GENERATION_EXTENSION_ID) {
    const result = await callOpenAiImageGenerationExtensionAction(config, env, action, args, context);
    if (result) return result;
  }

  if (extensionId === MICX_CLOUD_UPLOADS_EXTENSION_ID) {
    const result = await callMicxCloudUploadAction(config, action, args, context);
    if (result) return result;
  }

  throw new ApiError(501, "extension_action_not_implemented", `${registered.title} is registered but not implemented on micx-server yet.`, { extensionId, action, args });
}
