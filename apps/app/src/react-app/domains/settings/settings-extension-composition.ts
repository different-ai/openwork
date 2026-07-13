import { createContributionRegistry } from "@openwork/contribution-registry";

import { openAiImageGenSettingsContribution } from "./openai-image-gen-config";
import { ollamaSettingsContribution } from "./ollama-config";
import { computerUseSettingsContribution } from "./computer-use-config";
import { openWorkBrowserSettingsContribution } from "./browser-extension-config";
import { openWorkVoiceSettingsContribution } from "./openwork-voice-config";
import { googleWorkspaceSettingsContribution } from "./google-workspace-config";
import type {
  SettingsExtensionComposition,
  SettingsExtensionDescriptor,
  SettingsExtensionHost,
  SettingsExtensionLookup,
  SettingsExtensionRegistration,
  SettingsExtensionRuntime,
} from "./extension-registry";

/**
 * The renderer's complete settings-extension inventory. Adding a settings
 * contribution requires its module plus one explicit entry in this list.
 */
export const APP_SETTINGS_EXTENSION_CONTRIBUTIONS = [
  openAiImageGenSettingsContribution,
  ollamaSettingsContribution,
  computerUseSettingsContribution,
  openWorkBrowserSettingsContribution,
  openWorkVoiceSettingsContribution,
  googleWorkspaceSettingsContribution,
] as const satisfies readonly SettingsExtensionRegistration[];

const APP_SETTINGS_HOST: SettingsExtensionHost = { realm: "app-settings" };

type IndexedSettingsExtension =
  | {
      readonly status: "found";
      readonly descriptor: SettingsExtensionDescriptor;
      readonly runtime: SettingsExtensionRuntime;
    }
  | {
      readonly status: "unavailable";
      readonly descriptor: SettingsExtensionDescriptor;
      readonly reason: string;
    };

function unavailableReason(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function addRef(
  index: Map<string, IndexedSettingsExtension>,
  ref: string,
  extension: IndexedSettingsExtension,
) {
  const existing = index.get(ref);
  if (existing) {
    throw new Error(
      `Duplicate app settings extension ref "${ref}" from "${existing.descriptor.id}" and "${extension.descriptor.id}".`,
    );
  }
  index.set(ref, extension);
}

function lookup(
  index: ReadonlyMap<string, IndexedSettingsExtension>,
  ref: string,
): SettingsExtensionLookup {
  const extension = index.get(ref);
  if (!extension) return { status: "unknown", ref };
  return extension.status === "found"
    ? { status: "found", ref, descriptor: extension.descriptor, runtime: extension.runtime }
    : { status: "unavailable", ref, descriptor: extension.descriptor, reason: extension.reason };
}

export function createSettingsExtensionComposition(
  registrations: readonly SettingsExtensionRegistration[] = APP_SETTINGS_EXTENSION_CONTRIBUTIONS,
): SettingsExtensionComposition {
  const registry = createContributionRegistry<
    SettingsExtensionDescriptor,
    SettingsExtensionHost,
    SettingsExtensionRuntime
  >({ supportedContractVersions: [1] });

  registry.registerAll(registrations);
  const frozen = registry.freeze();
  if (frozen.status === "invalid") {
    throw new Error(
      `App settings extension composition is invalid (${frozen.snapshot.diagnostics.length} diagnostics).`,
    );
  }

  const settingsPanels = new Map<string, IndexedSettingsExtension>();
  const connections = new Map<string, IndexedSettingsExtension>();

  for (const result of registry.constructAll(APP_SETTINGS_HOST)) {
    if (result.status === "unknown" || result.status === "registry-not-ready") {
      throw new Error(`App settings extension registry returned unexpected status "${result.status}".`);
    }

    const extension: IndexedSettingsExtension = result.status === "constructed"
      ? { status: "found", descriptor: result.descriptor, runtime: result.value }
      : result.status === "failed"
        ? {
            status: "unavailable",
            descriptor: result.descriptor,
            reason: unavailableReason(result.cause),
          }
        : {
            status: "unavailable",
            descriptor: result.descriptor,
            reason: result.reason,
          };

    for (const ref of result.descriptor.settingsPanelRefs) {
      addRef(settingsPanels, ref, extension);
    }
    for (const ref of result.descriptor.connectionRefs) {
      addRef(connections, ref, extension);
    }
  }

  return Object.freeze({
    descriptors: Object.freeze(
      frozen.snapshot.entries.map((entry) => entry.descriptor),
    ),
    lookupSettingsPanel: (ref: string) => lookup(settingsPanels, ref),
    lookupConnection: (ref: string) => lookup(connections, ref),
  });
}

/** One immutable contribution registry for the React renderer realm. */
export const appSettingsExtensionComposition = createSettingsExtensionComposition();
