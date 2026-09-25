import { ApiError } from "./errors.js";
import type { EnvService, EnvRecord } from "./env-file.js";
import type { ServerConfig } from "./types.js";
import { readGlobalRuntimeOpencodeConfig, runtimeProviderMap, writeGlobalRuntimeOpencodeConfig, mergeRuntimeProviderUpdate } from "./runtime-opencode-config-store.js";
import { readOpenworkWorkspaceConfig, writeOpenworkWorkspaceConfig } from "./openwork-workspace-config-store.js";
import { writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";

const providers = new Map([
  ["anthropic", { name: "Anthropic", npm: "@ai-sdk/anthropic" }],
  ["openai", { name: "OpenAI", npm: "@ai-sdk/openai" }],
  ["google", { name: "Google", npm: "@ai-sdk/google" }],
  ["openrouter", { name: "OpenRouter", npm: "@openrouter/ai-sdk-provider" }],
]);
const metadataKey = "__local_provider_keys__";
const unsupported = () => new ApiError(409, "local_key_unavailable", "This credential cannot be shared safely. Reconnect a supported API-key provider on this device; custom providers and sign-in credentials stay private.");

export class LocalProviderKeys {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly config: ServerConfig, private readonly env: EnvService) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private definition(providerId: string) {
    const provider = providers.get(providerId);
    if (!provider) throw unsupported();
    return { name: provider.name, npm: provider.npm, env: [`LOCAL_PROVIDER_${providerId.toUpperCase()}_API_KEY`] };
  }

  async describe(providerId: string) {
    const definition = this.definition(providerId);
    const metadata = await readOpenworkWorkspaceConfig(this.config, metadataKey);
    const entry = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(this.config))[providerId];
    if (JSON.stringify(entry) !== JSON.stringify(definition) || typeof metadata[providerId] !== "number") throw unsupported();
    return { providerId, name: definition.name, addedAt: metadata[providerId], envKey: definition.env[0] };
  }

  async listMetadata() {
    const entries = await Promise.all([...providers.keys()].map(async (providerId) => {
      try { const entry = await this.describe(providerId); return { providerId, name: entry.name, savedAt: entry.addedAt }; }
      catch (error) { if (error instanceof ApiError && error.code === "local_key_unavailable") return null; throw error; }
    }));
    return entries.filter((entry) => entry !== null);
  }

  async save(providerId: string, key: string) {
    return this.enqueue(async () => {
      if (!this.config.anonymousInference?.desktop || this.config.readOnly) throw new ApiError(403, "desktop_required", "Device key storage requires the writable desktop host.");
      const definition = this.definition(providerId);
      await managedDesktopPolicy(this.config).assert("model", { providerID: providerId });
      const runtime = await readGlobalRuntimeOpencodeConfig(this.config);
      const current = runtimeProviderMap(runtime)[providerId];
      if (current !== undefined && JSON.stringify(current) !== JSON.stringify(definition)) throw unsupported();
      await this.env.upsertMany([{ key: definition.env[0], value: key }]);
      await writeGlobalRuntimeOpencodeConfig(this.config, (snapshot) => {
        const entry = runtimeProviderMap(snapshot)[providerId];
        if (entry !== undefined && JSON.stringify(entry) !== JSON.stringify(definition)) throw unsupported();
        return { ...snapshot, provider: mergeRuntimeProviderUpdate(snapshot.provider, { [providerId]: definition }), disabled_providers: snapshot.disabled_providers?.filter((id) => id !== providerId) };
      });
      await writeOpenworkWorkspaceConfig(this.config, metadataKey, (snapshot) => ({ ...snapshot, [providerId]: Date.now() }));
      await writeOpenworkRuntimeConfigFile(this.config);
      return { saved: true };
    });
  }

  async read(providerId: string): Promise<EnvRecord> {
    const metadata = await this.describe(providerId);
    const entry = await this.env.readSecret(metadata.envKey);
    if (!entry?.value) throw unsupported();
    return entry;
  }

  async remove(providerId: string, expected: EnvRecord, isCurrent: () => void): Promise<boolean> {
    return this.enqueue(async () => {
      const definition = this.definition(providerId);
      const current = await this.env.readSecret(definition.env[0]);
      isCurrent();
      if (!current || current.value !== expected.value || current.updatedAt !== expected.updatedAt) return false;
      await writeGlobalRuntimeOpencodeConfig(this.config, (runtime) => {
        isCurrent();
        if (JSON.stringify(runtimeProviderMap(runtime)[providerId]) !== JSON.stringify(definition)) throw unsupported();
        return { ...runtime, provider: mergeRuntimeProviderUpdate(runtime.provider, { [providerId]: null }) };
      });
      isCurrent();
      const removed = await this.env.deleteIfUnchanged(expected, isCurrent);
      await writeOpenworkRuntimeConfigFile(this.config);
      return removed;
    });
  }
}
