import { nativeModelVariants } from "@openwork/types/cloud-model-fast";
import { gatewayBase } from "./gateway-quota.js";
import type { OpencodeV2ModelSpec, OpencodeV2ProviderSpec } from "./managed-opencode-v2.js";

/**
 * AI Gateway providers on OpenCode v2, delivered live.
 *
 * Without this, gateway providers reach the engine like every other provider:
 * written to its config file, which the engine reloads asynchronously, so the
 * server polls until the catalog shows them. Here the context plugin waits on
 * the server for the current list and registers it in memory, so a change is
 * served as soon as the server has it. Legacy providers keep the file path.
 *
 * The records match what the engine builds from the same provider in its
 * config file (`renderOpencodeV2Config`), verified against a running engine:
 * plugin-added models get no engine defaults, so every field is explicit.
 */

type JsonRecord = Record<string, unknown>;
type Variant = { id: string; settings?: JsonRecord; headers?: Record<string, string>; body?: JsonRecord };

export type LiveModelInfo = {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  family?: string;
  settings?: JsonRecord;
  headers?: Record<string, string>;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  variants: Variant[];
  time: { released: number };
  cost: never[];
  status: "active";
  enabled: boolean;
  limit: { context: number; input?: number; output: number };
};

export type LiveProviderRecord = {
  info: {
    id: string;
    name: string;
    activation: "enabled";
    /**
     * Never registered and never holds a credential, so the engine always uses
     * the key in settings. Under the provider's own id it could pick up an
     * older key imported from the v1 engine's credentials.
     */
    integrationID: string;
    package: string;
    settings: JsonRecord;
    headers?: Record<string, string>;
  };
  models: LiveModelInfo[];
};

export const LIVE_GATEWAY_INTEGRATION_ID = "openwork-gateway";
const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : fallback;
}

/** Gateway providers only: an `ipr_` id routed through the gateway's provider path. */
export function isLiveGatewaySpec(spec: OpencodeV2ProviderSpec): boolean {
  return gatewayBase(spec.id, spec.baseUrl) !== undefined;
}

export function providerPackage(spec: Pick<OpencodeV2ProviderSpec, "package">): string {
  return spec.package?.replace(/^@opencode-ai\/ai\//, "@opencode/ai/") ?? DEFAULT_PACKAGE;
}

// ---- Engine variant defaults ----
// Port of OpenCode 2.0.26 `Variant.resolve` with its default `effort` support
// (packages/core/src/variant.ts), for the packages the v2 provider mirror
// accepts (`mapRuntimeProvidersToV2Specs`). The engine runs it for config
// models without `variants`, never for plugin models.

const EFFORTS = ["low", "medium", "high"];
const ADAPTIVE_THINKING = { type: "adaptive", display: "summarized" };
const ANTHROPIC_OUTPUT_TOKEN_MAX = 32_000;

const efforts = (values: readonly string[], spell: (effort: string) => Omit<Variant, "id">): Variant[] =>
  values.map((effort) => ({ id: effort, ...spell(effort) }));

function claudeInfo(modelID: string) {
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(modelID);
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(modelID);
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase();
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1]);
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0);
  return {
    family, major, minor,
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    always: family === "fable" || family === "mythos" || modelID.toLowerCase().includes("mythos-preview"),
  };
}

function anthropicVariants(modelID: string, outputLimit: number): Variant[] {
  const info = claudeInfo(modelID);
  const opus45 = info.family === "opus" && info.major === 4 && info.minor === 5;
  if (info.manual && !opus45) {
    // budget_tokens with min 1024, capped by the Anthropic output ceiling.
    const maximum = Math.min(outputLimit - 1, ANTHROPIC_OUTPUT_TOKEN_MAX - 1);
    if (maximum <= 0) return [];
    const high = Math.min(Math.max(1024, Math.floor((maximum + 1) / 2)), maximum);
    const budget = (tokens: number) => ({ settings: { thinking: { type: "enabled", budgetTokens: tokens } } });
    return [{ id: "high", ...budget(high) }, { id: "max", ...budget(maximum) }];
  }
  let thinking: JsonRecord | undefined = { thinking: ADAPTIVE_THINKING };
  if (opus45) {
    const tokens = Math.min(16_000, outputLimit - 1);
    thinking = tokens < 1024 ? undefined : { thinking: { type: "enabled", budgetTokens: tokens } };
  }
  if (!thinking) return [];
  const defaults = info.major === 4 && info.minor === 6 ? [...EFFORTS, "max"] : [...EFFORTS, "xhigh", "max"];
  const values = defaults.filter((effort) => !info.always || effort !== "none");
  return efforts(values, (effort) => effort === "none"
    ? { settings: { thinking: { type: "disabled" } } }
    : { settings: { ...thinking, effort } });
}

export function engineDefaultVariants(pkg: string, modelID: string, outputLimit: number): Variant[] {
  switch (pkg) {
    case "@opencode/ai/providers/openai":
      return efforts(["none", "minimal", ...EFFORTS, "xhigh"], (effort) => ({
        settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
      }));
    case "@opencode/ai/providers/openai-compatible":
      return efforts(EFFORTS, (effort) => ({ settings: { reasoningEffort: effort } }));
    case "@opencode/ai/providers/openrouter":
      return efforts(EFFORTS, (effort) => ({ settings: { reasoning: { effort } } }));
    case "@opencode/ai/providers/anthropic":
      return anthropicVariants(modelID, outputLimit);
    default:
      return [];
  }
}

// ---- Spec → plugin records ----

/** The config file writes 128k/8k when a model has no limit; a partial limit
 * is merged over the engine's model default (200k/32k). */
function limitOf(config: JsonRecord): LiveModelInfo["limit"] {
  if (!isRecord(config.limit)) return { context: 128_000, output: 8_192 };
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const input = number(config.limit.input);
  return {
    context: number(config.limit.context) ?? 200_000,
    ...(input === undefined ? {} : { input }),
    output: number(config.limit.output) ?? 32_000,
  };
}

function modelRecord(spec: OpencodeV2ProviderSpec, pkg: string, model: OpencodeV2ModelSpec): LiveModelInfo {
  const config = model.config ?? {};
  const modalities = isRecord(config.modalities) ? config.modalities : {};
  const output = stringList(modalities.output, ["text"]);
  const modelID = typeof config.id === "string" ? config.id : model.id;
  const limit = limitOf(config);
  const headers = stringRecord(config.headers);
  return {
    id: model.id,
    modelID,
    providerID: spec.id,
    name: model.name,
    ...(typeof config.family === "string" ? { family: config.family } : {}),
    ...(isRecord(config.options) ? { settings: config.options } : {}),
    ...(headers ? { headers } : {}),
    capabilities: {
      tools: typeof config.tool_call === "boolean" ? config.tool_call : true,
      input: stringList(modalities.input, ["text"]),
      output: config.reasoning === true ? [...new Set([...output, "reasoning"])] : output,
    },
    // Explicit variants (or a model that cannot reason) are written as in the
    // config file; otherwise the engine's own defaults for this package.
    variants: isRecord(config.variants) || config.reasoning === false
      ? nativeModelVariants(config.variants, pkg)
      : engineDefaultVariants(pkg, modelID, limit.output),
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: config.status !== "deprecated",
    limit,
  };
}

export function liveProviderRecord(spec: OpencodeV2ProviderSpec): LiveProviderRecord {
  const pkg = providerPackage(spec);
  const headers = stringRecord(spec.headers);
  return {
    info: {
      id: spec.id,
      name: spec.name,
      activation: "enabled",
      integrationID: LIVE_GATEWAY_INTEGRATION_ID,
      package: pkg,
      settings: {
        ...spec.settings,
        apiKey: spec.apiKey,
        ...(spec.baseUrl ? { baseURL: spec.baseUrl } : {}),
        name: spec.id,
      },
      ...(headers ? { headers } : {}),
    },
    // As in the config file: models outside the allow/deny lists are left
    // out; deprecated ones stay registered but disabled, hidden from the catalog.
    models: spec.models
      .filter((model) => (spec.whitelist === undefined || spec.whitelist.includes(model.id)) && !spec.blacklist?.includes(model.id))
      .map((model) => modelRecord(spec, pkg, model)),
  };
}

// ---- Server → plugin channel ----

export type LiveProvidersSnapshot = { revision: number; enabled: boolean; providers: LiveProviderRecord[] };

/**
 * The current live providers, versioned. Readers pass the revision they have
 * and wait until it changes, so the plugin learns of a change immediately
 * without polling the server.
 */
export function createLiveProvidersChannel() {
  let snapshot: LiveProvidersSnapshot = { revision: 0, enabled: false, providers: [] };
  let fingerprint = JSON.stringify([false, []]);
  const waiters = new Set<() => void>();

  return {
    current: (): LiveProvidersSnapshot => snapshot,
    /** Returns true when what the plugin serves changed. */
    publish(enabled: boolean, providers: LiveProviderRecord[]): boolean {
      const next = JSON.stringify([enabled, providers]);
      if (next === fingerprint) return false;
      fingerprint = next;
      snapshot = { revision: snapshot.revision + 1, enabled, providers };
      for (const wake of [...waiters]) wake();
      return true;
    },
    /** Resolves at once when `revision` is stale, else on the next change or after `waitMs`. */
    async read(input: { revision?: number; waitMs?: number }, signal?: AbortSignal): Promise<LiveProvidersSnapshot> {
      const waitMs = Math.max(0, Math.min(input.waitMs ?? 0, 25_000));
      if (input.revision !== snapshot.revision || waitMs === 0) return snapshot;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
      return snapshot;
    },
  };
}

export type LiveProvidersChannel = ReturnType<typeof createLiveProvidersChannel>;
