import type { ModelRef } from "../../../app/types";
import type { DenDesktopConfig } from "../../../app/lib/den";
import { isOpencodeV2BaseUrl } from "../../../app/lib/opencode-v2-adapter";

/**
 * The model the member's organization (or one of their teams) wants new chats
 * to start with, from the desktop config.
 *
 * Only the OpenCode v2 engine applies it: on v1, or before the workspace's
 * engine is known, this is null. A missing value means "no organization
 * default". It sits under a model the member picked for the
 * workspace and above the app's own default, so members can still change the
 * model for a new chat and in each chat.
 */
export function orgDefaultModelForEngine(
  defaultModel: DenDesktopConfig["defaultModel"],
  opencodeBaseUrl: string | null | undefined,
): ModelRef | null {
  if (!defaultModel || !opencodeBaseUrl || !isOpencodeV2BaseUrl(opencodeBaseUrl)) return null;
  const providerID = defaultModel.providerID.trim();
  const modelID = defaultModel.modelID.trim();
  return providerID && modelID ? { providerID, modelID } : null;
}

/**
 * The default a new chat starts on: the member's own pick for the workspace,
 * else the organization's (v2 only, see above), else the app's own default.
 * The variant follows the model it came with.
 */
export function newChatDefaultModel(input: {
  workspaceDefault: { model: ModelRef; variant: string | null } | null;
  orgDefault: ModelRef | null;
  appDefault: { model: ModelRef | null; variant: string | null };
}): { model: ModelRef | null; variant: string | null } {
  if (input.workspaceDefault) return input.workspaceDefault;
  if (input.orgDefault) return { model: input.orgDefault, variant: null };
  return input.appDefault;
}
