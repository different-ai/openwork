import { ApiError } from "../errors.js";
import type {
  ExtensionActionContribution,
  ExtensionActionHostContext,
  ExtensionActionService,
} from "./action-contract.js";

export type ExtensionActionRegistryPort = {
  readonly list: () => readonly ExtensionActionContribution[];
  readonly lookup: (extensionId: string, action: string) => ExtensionActionContribution | undefined;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, key: string): string {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field.trim() : "";
}

export function createExtensionActionService(registry: ExtensionActionRegistryPort): ExtensionActionService {
  return {
    list(extensionId, hostContext = {}) {
      const filter = extensionId.trim();
      return registry
        .list()
        .filter((contribution) => !filter || contribution.descriptor.extensionId === filter)
        .filter((contribution) => !contribution.isListed || contribution.isListed(hostContext))
        .map((contribution) => contribution.descriptor);
    },
    async call(input, hostContext: ExtensionActionHostContext = {}) {
      if (!isRecord(input)) {
        throw new ApiError(400, "invalid_payload", "Expected extension action call payload");
      }
      const extensionId = readStringField(input, "extensionId");
      const action = readStringField(input, "action");
      const args = isRecord(input.args) ? input.args : {};
      const clientContext = isRecord(input.context) ? input.context : {};
      if (!extensionId || !action) {
        throw new ApiError(400, "invalid_payload", "extensionId and action are required");
      }

      const contribution = registry.lookup(extensionId, action);
      if (!contribution) {
        throw new ApiError(404, "extension_action_not_found", "OpenWork extension action not found");
      }
      if (!contribution.execute) {
        throw new ApiError(
          501,
          "extension_action_not_implemented",
          `${contribution.descriptor.title} is registered but not implemented on openwork-server yet.`,
          { extensionId, action, args },
        );
      }

      return contribution.execute({ args, clientContext, hostContext });
    },
  };
}
