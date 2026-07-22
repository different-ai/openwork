import { createHash, randomUUID } from "node:crypto";
import { systemBlockSources, type SystemPromptSource } from "./lib/system-provenance.js";

type RemoteObservabilityConfig = {
  enabled: boolean;
  scopes: string[];
  content: "metadata" | "hash" | "full";
  collectionEpoch: number;
};

type PreviousPrompt = {
  hash: string;
  blockHashes: string[];
  blockCount: number;
};

type Observation = {
  level: "debug" | "info" | "warn" | "error";
  scope: "lifecycle" | "prompt";
  action: string;
  source: { runtime: "opencode"; component: string; instanceId: string; operation?: string };
  observedAt?: string;
  context?: unknown;
  cause?: unknown;
  data?: unknown;
  content?: Record<string, unknown>;
};

const CONFIG_CACHE_MS = 750;
const REQUEST_TIMEOUT_MS = 2_000;
const FACTORY_RETRY_MS = 2_000;
const FACTORY_RETRY_MAX_MS = 5 * 60_000;
const MAX_TRACKED_SESSIONS = 200;
const MAX_PROMPT_METADATA_BLOCKS = 1_000;
const MAX_CHANGED_INDICES = 1_000;
const MAX_PROMPT_VALUE_JSON_BYTES = 1 * 1024 * 1024;
const PROVIDER_BOUNDARY = "Captured at the final configured plugin hook, before OpenCode post-hook block normalization and provider-native additions; downstream representations are not observable from the plugin API.";
const JSON_ENCODER = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, key: string, maxLength = 1_024): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim().slice(0, maxLength)
    : undefined;
}

function hookContext(value: unknown): Record<string, string> {
  const nested = isRecord(value) && isRecord(value.context) ? value.context : value;
  const sessionId = optionalString(nested, "sessionID") ?? optionalString(nested, "sessionId");
  const messageId = optionalString(nested, "messageID") ?? optionalString(nested, "messageId");
  const agent = optionalString(nested, "agent");
  const directory = optionalString(nested, "directory") ?? optionalString(nested, "worktree");
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(agent ? { agent } : {}),
    ...(directory ? { directory } : {}),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function changedBlockIndices(previous: string[], next: string[]): number[] {
  const changed: number[] = [];
  for (let index = 0; index < Math.max(previous.length, next.length); index += 1) {
    if (previous[index] !== next[index]) {
      changed.push(index);
      if (changed.length >= MAX_CHANGED_INDICES) break;
    }
  }
  return changed;
}

function promptArrayHash(blocks: string[]): string {
  const hash = createHash("sha256");
  hash.update("[");
  for (let index = 0; index < blocks.length; index += 1) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify(blocks[index] ?? ""));
  }
  hash.update("]");
  return hash.digest("hex");
}

function capturedPromptValue(blocks: string[]): {
  value: string[];
  complete: boolean;
  capturedHash: string;
} {
  const value: string[] = [];
  let bytes = JSON_ENCODER.encode("[]").byteLength;
  let complete = true;

  for (const block of blocks) {
    const separatorBytes = value.length === 0 ? 0 : 1;
    const serialized = JSON.stringify(block);
    const serializedBytes = JSON_ENCODER.encode(serialized).byteLength;
    if (bytes + separatorBytes + serializedBytes <= MAX_PROMPT_VALUE_JSON_BYTES) {
      value.push(block);
      bytes += separatorBytes + serializedBytes;
      continue;
    }

    complete = false;
    const available = MAX_PROMPT_VALUE_JSON_BYTES - bytes - separatorBytes;
    let low = 0;
    let high = block.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidateBytes = JSON_ENCODER.encode(JSON.stringify(block.slice(0, middle))).byteLength;
      if (candidateBytes <= available) low = middle;
      else high = middle - 1;
    }
    if (low > 0) value.push(block.slice(0, low));
    break;
  }

  if (value.length !== blocks.length) complete = false;
  return { value, complete, capturedHash: promptArrayHash(value) };
}

function serverConnection(): { url: string; token: string; observabilityToken: string } | null {
  const url = process.env.OPENWORK_SERVER_URL?.trim().replace(/\/+$/, "") ?? "";
  const token = process.env.OPENWORK_SERVER_TOKEN?.trim() ?? "";
  const observabilityToken = process.env.OPENWORK_OBSERVABILITY_TOKEN?.trim() ?? "";
  return url && token && observabilityToken ? { url, token, observabilityToken } : null;
}

function parseRemoteConfig(value: unknown): RemoteObservabilityConfig | null {
  const config = isRecord(value) && isRecord(value.config) ? value.config : null;
  const collectionEpoch = isRecord(value) && typeof value.collectionEpoch === "number"
    && Number.isSafeInteger(value.collectionEpoch) && value.collectionEpoch >= 0
    ? value.collectionEpoch
    : 0;
  if (
    !config
    || typeof config.enabled !== "boolean"
    || !Array.isArray(config.scopes)
    || (config.content !== "metadata" && config.content !== "hash" && config.content !== "full")
  ) return null;
  return {
    enabled: config.enabled,
    scopes: config.scopes.filter((scope): scope is string => typeof scope === "string"),
    content: config.content,
    collectionEpoch,
  };
}

function rememberPrompt(map: Map<string, PreviousPrompt>, sessionId: string, value: PreviousPrompt): void {
  map.delete(sessionId);
  map.set(sessionId, value);
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (typeof oldest !== "string") break;
    map.delete(oldest);
  }
}

function runtimePromptComposition(
  block: string,
  blockHash: string,
): {
  source: SystemPromptSource;
  parts?: Array<{ source: string; hash: string; length: number }>;
} | null {
  const agentPromptHash = process.env.OPENWORK_AGENT_PROMPT_SHA256?.trim();
  const configuredLength = Number(process.env.OPENWORK_AGENT_PROMPT_LENGTH);
  if (!agentPromptHash) return null;
  if (blockHash === agentPromptHash) {
    return { source: "openwork.runtime-config.agent.openwork.prompt" };
  }
  if (
    !Number.isInteger(configuredLength)
    || configuredLength <= 0
    || block.length <= configuredLength
    || block[configuredLength] !== "\n"
  ) return null;
  const promptPart = block.slice(0, configuredLength);
  if (sha256(promptPart) !== agentPromptHash) return null;
  const corePart = block.slice(configuredLength);
  return {
    source: "opencode-core-composed-header",
    parts: [
      {
        source: "openwork.runtime-config.agent.openwork.prompt",
        hash: agentPromptHash,
        length: promptPart.length,
      },
      {
        source: "opencode-core-session-context",
        hash: sha256(corePart),
        length: corePart.length,
      },
    ],
  };
}

// This must remain the sole export: OpenCode treats every plugin-module export
// as a plugin factory.
export const OpenWorkObservability = async (factoryInput?: unknown) => {
  const instanceId = process.env.OPENWORK_OPENCODE_INSTANCE_ID?.trim() || randomUUID();
  const factoryId = randomUUID();
  const instantiatedAt = new Date().toISOString();
  const factoryContext = hookContext(factoryInput);
  const previousBySession = new Map<string, PreviousPrompt>();
  let cachedConfig: RemoteObservabilityConfig | null = null;
  let cachedConfigAt = 0;
  let configRequest: Promise<RemoteObservabilityConfig | null> | null = null;
  let activeEpoch: number | null = null;
  let factoryAnnouncedEpoch: number | null = null;
  let factoryAnnouncement: Promise<void> | null = null;
  let factoryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let factoryRetryDelayMs = FACTORY_RETRY_MS;

  const readConfig = async (force = false): Promise<RemoteObservabilityConfig | null> => {
    if (!force && cachedConfig && Date.now() - cachedConfigAt < CONFIG_CACHE_MS) return cachedConfig;
    if (configRequest) {
      const pending = await configRequest;
      if (!force) return pending;
      // A forced read is an activation boundary. If another request started
      // before the owner toggle, follow it with a new request rather than
      // trusting its potentially stale result.
    }
    configRequest = (async () => {
      const connection = serverConnection();
      if (!connection) return null;
      try {
        const response = await fetch(`${connection.url}/observability/config`, {
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "X-OpenWork-Observability-Token": connection.observabilityToken,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) return null;
        const config = parseRemoteConfig(await response.json());
        if (config) {
          if (config.enabled && activeEpoch !== config.collectionEpoch) {
            activeEpoch = config.collectionEpoch;
            previousBySession.clear();
          }
          cachedConfig = config;
          cachedConfigAt = Date.now();
        }
        return config;
      } catch {
        return null;
      } finally {
        configRequest = null;
      }
    })();
    return configRequest;
  };

  const post = async (config: RemoteObservabilityConfig, observation: Observation): Promise<boolean> => {
    if (!config.enabled || !config.scopes.includes(observation.scope)) return false;
    const connection = serverConnection();
    if (!connection) return false;
    try {
      const response = await fetch(`${connection.url}/observability/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "X-OpenWork-Observability-Token": connection.observabilityToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [observation] }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const result: unknown = await response.json();
      return isRecord(result) && result.accepted === 1;
    } catch {
      // Observability must never interrupt a chat request.
      return false;
    }
  };

  const announceFactory = async (config: RemoteObservabilityConfig): Promise<void> => {
    if (
      factoryAnnouncedEpoch === config.collectionEpoch
      || !config.enabled
      || !config.scopes.includes("lifecycle")
    ) return;
    if (factoryAnnouncement) await factoryAnnouncement;
    if (factoryAnnouncedEpoch === config.collectionEpoch) return;
    const announcementEpoch = config.collectionEpoch;
    const pending = (async () => {
      const posted = await post(config, {
        level: "info",
        scope: "lifecycle",
        action: "plugin.factory.instantiated",
        source: {
          runtime: "opencode",
          component: "openwork-observability",
          instanceId,
          operation: "plugin.factory",
        },
        // The server may not be listening yet when OpenCode constructs this
        // plugin. Preserve the actual construction time even if delivery is
        // deferred until the first observed prompt.
        observedAt: instantiatedAt,
        context: factoryContext,
        data: {
          plugin: "openwork-observability",
          factoryId,
          collectionEpoch: announcementEpoch,
          position: "last-configured-plugin",
          providerBoundary: PROVIDER_BOUNDARY,
        },
      });
      if (posted) {
        factoryAnnouncedEpoch = announcementEpoch;
        if (factoryRetryTimer) {
          clearTimeout(factoryRetryTimer);
          factoryRetryTimer = null;
        }
      }
    })();
    factoryAnnouncement = pending;
    try {
      await pending;
    } finally {
      if (factoryAnnouncement === pending) factoryAnnouncement = null;
    }
  };

  const attemptFactoryAnnouncement = async (): Promise<RemoteObservabilityConfig | null> => {
    const config = await readConfig();
    if (config) await announceFactory(config);
    return config;
  };
  const scheduleFactoryRetry = () => {
    const config = cachedConfig;
    if (
      (config?.enabled && !config.scopes.includes("lifecycle"))
      || (config?.enabled && factoryAnnouncedEpoch === config.collectionEpoch)
      || factoryRetryTimer
      || !serverConnection()
    ) return;
    factoryRetryTimer = setTimeout(() => {
      factoryRetryTimer = null;
      void attemptFactoryAnnouncement().finally(() => {
        factoryRetryDelayMs = Math.min(factoryRetryDelayMs * 2, FACTORY_RETRY_MAX_MS);
        scheduleFactoryRetry();
      });
    }, factoryRetryDelayMs);
    factoryRetryTimer.unref?.();
  };

  // Best effort at factory time. A bounded, unref'd retry also covers an idle
  // already-running instance when Developer Mode is enabled later; this does
  // not depend on a prompt being sent just to make construction observable.
  void attemptFactoryAnnouncement().finally(scheduleFactoryRetry);

  return {
    event: async () => {
      factoryRetryDelayMs = FACTORY_RETRY_MS;
      await attemptFactoryAnnouncement();
      if (activeEpoch === null || factoryAnnouncedEpoch !== activeEpoch) scheduleFactoryRetry();
    },
    "experimental.chat.system.transform": async (input: unknown, output: { system: string[] }) => {
      // Prompt capture is the exactness boundary. Bypass the short lifecycle
      // cache so a prompt sent immediately after an off/on or policy change is
      // evaluated against the owner's current collection epoch and policy.
      const config = await readConfig(true);
      if (!config?.enabled) return;
      await announceFactory(config);
      if (!config.scopes.includes("prompt")) return;

      const context = { ...factoryContext, ...hookContext(input) };
      const sessionId = context.sessionId;
      const blockHashes = output.system
        .slice(0, MAX_PROMPT_METADATA_BLOCKS)
        .map(sha256);
      const promptHash = promptArrayHash(output.system);
      const totalLength = output.system.reduce((total, block) => total + block.length, 0);
      const trackedSources = systemBlockSources(output.system, MAX_PROMPT_METADATA_BLOCKS);

      const emitPrompt = async (activeConfig: RemoteObservabilityConfig): Promise<boolean> => {
        const previous = sessionId ? previousBySession.get(sessionId) : undefined;
        const changedIndices = changedBlockIndices(previous?.blockHashes ?? [], blockHashes);
        const includeHashes = activeConfig.content !== "metadata";
        const blockMetadata = output.system.slice(0, MAX_PROMPT_METADATA_BLOCKS).map((block, index) => {
          const composition = runtimePromptComposition(block, blockHashes[index] ?? sha256(block));
          return {
            index,
            ...(includeHashes ? { hash: blockHashes[index] } : {}),
            length: block.length,
            source: composition?.source ?? trackedSources[index] ?? "opencode-core-or-runtime-plugin",
            ...(composition?.parts ? {
              parts: composition.parts.map((part) => ({
                source: part.source,
                length: part.length,
                ...(includeHashes ? { hash: part.hash } : {}),
              })),
            } : {}),
          };
        });
        const status = !previous ? "initial" : previous.hash === promptHash ? "unchanged" : "changed";
        const metadataTruncated = output.system.length > blockMetadata.length;
        const fullCapture = activeConfig.content === "full" ? capturedPromptValue(output.system) : null;
        const posted = await post(activeConfig, {
          level: status === "unchanged" ? "debug" : "info",
          scope: "prompt",
          action: status === "changed" ? "system-prompt.changed" : "system-prompt.snapshot",
          source: {
            runtime: "opencode",
            component: "openwork-observability",
            instanceId,
            operation: "experimental.chat.system.transform",
          },
          observedAt: new Date().toISOString(),
          context,
          ...(includeHashes && previous ? { cause: { previousPromptHash: previous.hash } } : {}),
          data: {
            status,
            factoryId,
            collectionEpoch: activeConfig.collectionEpoch,
            ...(includeHashes ? {
              promptHash,
              previousPromptHash: previous?.hash,
            } : {}),
            blockCount: output.system.length,
            totalLength,
            changedIndices,
            changedIndicesComplete: !metadataTruncated
              && (previous?.blockCount ?? 0) <= MAX_PROMPT_METADATA_BLOCKS
              && changedIndices.length < MAX_CHANGED_INDICES,
            metadataTruncated,
            capturedBlockCount: fullCapture?.value.length,
            blocks: blockMetadata,
            providerBoundary: PROVIDER_BOUNDARY,
          },
          content: fullCapture
            ? {
                kind: "system-prompt",
                hash: promptHash,
                rawHash: promptHash,
                capturedHash: fullCapture.capturedHash,
                length: totalLength,
                complete: fullCapture.complete,
                truncated: !fullCapture.complete,
                value: fullCapture.value,
              }
            : activeConfig.content === "hash"
              ? {
                  kind: "system-prompt",
                  hash: promptHash,
                  length: totalLength,
                }
              : {
                  kind: "system-prompt",
                  length: totalLength,
                },
        });

        if (posted && sessionId) {
          rememberPrompt(previousBySession, sessionId, {
            hash: promptHash,
            blockHashes,
            blockCount: output.system.length,
          });
        }
        return posted;
      };

      const posted = await emitPrompt(config);
      if (posted) return;

      // If the owner crossed another off/on boundary between the forced read
      // and ingestion, the server rejects the stale epoch. Refresh once and
      // rebuild from the now-reset lineage so the first prompt is not lost or
      // attributed to the previous collection window.
      const refreshed = await readConfig(true);
      if (
        refreshed?.enabled
        && refreshed.scopes.includes("prompt")
        && refreshed.collectionEpoch !== config.collectionEpoch
      ) {
        await announceFactory(refreshed);
        await emitPrompt(refreshed);
      }
    },
  };
};
