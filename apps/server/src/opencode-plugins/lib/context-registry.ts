import { createHash } from "node:crypto";

import {
  logPromptDebug,
  promptDebugEnabled,
  promptTraceId,
  recordPromptContributorProvenance,
} from "../openwork-debug-log.js";
import {
  mergeTransformInputWithFactoryContext,
  normalizeOpenCodeContext,
  readEngineMcpStatusClient,
  type OpenCodeContext,
  type OpenWorkEngineMcpStatusClient,
} from "./context.js";
import {
  classifyOpenWorkContextBundleFailure,
  fetchOpenWorkContextBundle,
  type OpenWorkContextBundle,
} from "./connect-steering.js";
import { getRecordProperty } from "./records.js";
import { type OpenWorkFetch } from "./server-client.js";
import { createTtlCache, type TtlCache } from "./ttl-cache.js";

export type GateResult = { enabled: true } | { enabled: false; reason: string };

export type CachePolicy = { scope: "none" } | { scope: "process"; ttlMs?: number };

export type ContributorEnv = {
  env: NodeJS.ProcessEnv;
  factoryContext: OpenCodeContext;
};

export type ContextBundle = OpenWorkContextBundle;

export type OpenWorkEngineMcpStatusSource = {
  client?: OpenWorkEngineMcpStatusClient;
  directory?: string;
};

export type ResolveInput = {
  sessionID?: string;
  traceId: string;
  context: OpenCodeContext;
  sourceInput: unknown;
  bundle: ContextBundle | null;
  fetcher: OpenWorkFetch;
  engine?: OpenWorkEngineMcpStatusSource;
};

export type Base = {
  id: string;
  order: number;
  description: string;
  gate?: (env: ContributorEnv) => GateResult;
  gateEnv?: readonly string[];
  cache: CachePolicy;
  onError: { mode: "omit" } | { mode: "fallback"; text: string };
};

export type EngineToolDefinition = Readonly<Record<string, unknown>>;

export type ChatParamsOutput = {
  options: Record<string, unknown>;
};

export type ChatMessagesOutput = {
  messages: unknown[];
};

export type SystemBlockContributor = Base & {
  kind: "system-block";
  resolve(input: ResolveInput): Promise<string | null> | string | null;
};

export type ToolContributor = Base & {
  kind: "tool";
  readonly toolNames: readonly string[];
  tools(env: ContributorEnv): Record<string, EngineToolDefinition>;
};

export type ParamsContributor = Base & {
  kind: "params";
  chatParams(input: unknown, output: ChatParamsOutput): void;
};

export type MessagesContributor = Base & {
  kind: "messages";
  transformMessages(input: unknown, output: ChatMessagesOutput, env: ContributorEnv): Promise<void>;
};

export type FetchPatchContributor = Base & {
  kind: "fetch-patch";
  install(): void;
};

export type ContextContributor =
  | SystemBlockContributor
  | ToolContributor
  | ParamsContributor
  | MessagesContributor
  | FetchPatchContributor;

export type ContextRegistryDescription = {
  id: string;
  kind: ContextContributor["kind"];
  order: number;
  gate: "always" | "contributor-env";
  gateEnv: string[];
  toolNames: string[];
  cache: CachePolicy;
  description: string;
};

export type ContextRegistryGateEvaluation = {
  id: string;
  enabled: boolean;
  reason: "always" | "gate_enabled" | "gate_disabled" | "gate_error";
};

export type ContextPluginHooks = {
  "experimental.chat.system.transform"?: (
    input: unknown,
    output: { system: string[] },
  ) => Promise<void>;
  tool?: Record<string, EngineToolDefinition>;
  "chat.params"?: (input: unknown, output: ChatParamsOutput) => Promise<void>;
  "experimental.chat.messages.transform"?: (
    input: unknown,
    output: ChatMessagesOutput,
  ) => Promise<void>;
};

export type ContextPluginFactory = (factoryInput?: unknown) => Promise<ContextPluginHooks>;

const PROCESS_CACHE_KEY = "value";

const systemBlockCaches = new WeakMap<
  SystemBlockContributor,
  TtlCache<typeof PROCESS_CACHE_KEY, string | null>
>();
const toolCaches = new WeakMap<
  ToolContributor,
  TtlCache<typeof PROCESS_CACHE_KEY, Record<string, EngineToolDefinition>>
>();
const fetchPatchCaches = new WeakMap<
  FetchPatchContributor,
  TtlCache<typeof PROCESS_CACHE_KEY, void>
>();

function sortedRegistry(registry: readonly ContextContributor[]): ContextContributor[] {
  return registry
    .map((contributor, index) => ({ contributor, index }))
    .sort((left, right) => left.contributor.order - right.contributor.order || left.index - right.index)
    .map(({ contributor }) => contributor);
}

function processCacheTtl(policy: Extract<CachePolicy, { scope: "process" }>): number {
  return policy.ttlMs ?? Number.POSITIVE_INFINITY;
}

function systemBlockCache(contributor: SystemBlockContributor): TtlCache<typeof PROCESS_CACHE_KEY, string | null> {
  const cached = systemBlockCaches.get(contributor);
  if (cached) return cached;
  if (contributor.cache.scope !== "process") {
    throw new Error(`Context contributor ${contributor.id} does not declare process caching`);
  }
  const created = createTtlCache<typeof PROCESS_CACHE_KEY, string | null>(processCacheTtl(contributor.cache));
  systemBlockCaches.set(contributor, created);
  return created;
}

function toolCache(
  contributor: ToolContributor,
): TtlCache<typeof PROCESS_CACHE_KEY, Record<string, EngineToolDefinition>> {
  const cached = toolCaches.get(contributor);
  if (cached) return cached;
  if (contributor.cache.scope !== "process") {
    throw new Error(`Context contributor ${contributor.id} does not declare process caching`);
  }
  const created = createTtlCache<typeof PROCESS_CACHE_KEY, Record<string, EngineToolDefinition>>(
    processCacheTtl(contributor.cache),
  );
  toolCaches.set(contributor, created);
  return created;
}

function fetchPatchCache(contributor: FetchPatchContributor): TtlCache<typeof PROCESS_CACHE_KEY, void> {
  const cached = fetchPatchCaches.get(contributor);
  if (cached) return cached;
  if (contributor.cache.scope !== "process") {
    throw new Error(`Context contributor ${contributor.id} does not declare process caching`);
  }
  const created = createTtlCache<typeof PROCESS_CACHE_KEY, void>(processCacheTtl(contributor.cache));
  fetchPatchCaches.set(contributor, created);
  return created;
}

type ContributorFailureStage =
  | "gate-evaluation"
  | "tool-resolution"
  | "fetch-patch-install"
  | "system-block-resolution"
  | "params-transform"
  | "messages-transform";

function contributorFailureClassification(error: unknown): "error" | "non-error-throw" {
  return error instanceof Error ? "error" : "non-error-throw";
}

function logContributorFailure(
  contributor: ContextContributor,
  stage: ContributorFailureStage,
  error: unknown,
  traceId?: string,
): void {
  const trace = traceId ? ` trace=${traceId}` : "";
  console.error(
    `[openwork][context]${trace} id=${contributor.id} kind=${contributor.kind} stage=${stage} onError=${contributor.onError.mode} classification=${contributorFailureClassification(error)}`,
  );
}

type GateEvaluation = GateResult | { enabled: false; error: unknown };

function evaluateContributorGate(contributor: ContextContributor, env: ContributorEnv): GateEvaluation {
  try {
    const result = contributor.gate?.(env) ?? { enabled: true };
    if (!result.enabled) {
      logPromptDebug("context", `id=${contributor.id} enabled=false reason=${result.reason}`);
    }
    return result;
  } catch (error) {
    return { enabled: false, error };
  }
}

function contributorEnabled(
  contributor: ContextContributor,
  evaluations: ReadonlyMap<ContextContributor, GateEvaluation>,
): boolean {
  const evaluation = evaluations.get(contributor);
  if (!evaluation) throw new Error(`Missing gate evaluation for context contributor ${contributor.id}`);
  if ("error" in evaluation) throw evaluation.error;
  return evaluation.enabled;
}

function contributorFailureStage(
  contributor: ContextContributor,
  evaluations: ReadonlyMap<ContextContributor, GateEvaluation>,
  stage: ContributorFailureStage,
): ContributorFailureStage {
  const evaluation = evaluations.get(contributor);
  return evaluation && "error" in evaluation ? "gate-evaluation" : stage;
}

function logSystemBlockAttribution(
  contributor: SystemBlockContributor,
  text: string,
  traceId: string,
): void {
  if (!promptDebugEnabled()) return;
  const hash = createHash("sha256").update(text).digest("hex");
  recordPromptContributorProvenance(traceId, {
    contributorId: contributor.id,
    text,
    chars: text.length,
    hash,
  });
  logPromptDebug("context", `trace=${traceId} id=${contributor.id} chars=${text.length} sha256=${hash}`);
}

function appendSystemBlock(
  contributor: SystemBlockContributor,
  output: { system: string[] },
  text: string | null,
  traceId: string,
): void {
  if (!text) {
    logPromptDebug("context", `trace=${traceId} id=${contributor.id} omitted=true reason=empty`);
    return;
  }
  output.system.push(text);
  logSystemBlockAttribution(contributor, text, traceId);
}

async function resolveSystemBlock(contributor: SystemBlockContributor, input: ResolveInput): Promise<string | null> {
  if (contributor.cache.scope === "none") return contributor.resolve(input);
  return systemBlockCache(contributor).get(PROCESS_CACHE_KEY, async () => contributor.resolve(input));
}

async function resolveTools(
  contributor: ToolContributor,
  env: ContributorEnv,
): Promise<Record<string, EngineToolDefinition>> {
  if (contributor.cache.scope === "none") return contributor.tools(env);
  return toolCache(contributor).get(PROCESS_CACHE_KEY, async () => contributor.tools(env));
}

async function installFetchPatch(contributor: FetchPatchContributor): Promise<void> {
  if (contributor.cache.scope === "none") {
    contributor.install();
    return;
  }
  await fetchPatchCache(contributor).get(PROCESS_CACHE_KEY, async () => contributor.install());
}

function isOpenWorkFetch(value: unknown): value is OpenWorkFetch {
  return typeof value === "function";
}

function readFactoryFetcher(factoryInput: unknown): OpenWorkFetch {
  const candidate = getRecordProperty(factoryInput, "fetcher");
  return isOpenWorkFetch(candidate) ? candidate : fetch;
}

function engineSource(
  factoryInput: unknown,
  factoryContext: OpenCodeContext,
): OpenWorkEngineMcpStatusSource | undefined {
  const client = readEngineMcpStatusClient(factoryInput);
  const directory = factoryContext.directory ?? factoryContext.worktree;
  if (!client && !directory) return undefined;
  return {
    ...(client ? { client } : {}),
    ...(directory ? { directory } : {}),
  };
}

function resolveInput(
  input: unknown,
  factoryContext: OpenCodeContext,
  fetcher: OpenWorkFetch,
  engine: OpenWorkEngineMcpStatusSource | undefined,
): ResolveInput {
  const sourceInput = mergeTransformInputWithFactoryContext(input, factoryContext);
  const context = {
    ...factoryContext,
    ...normalizeOpenCodeContext(input),
  };
  return {
    ...(context.sessionID ? { sessionID: context.sessionID } : {}),
    traceId: promptTraceId(input),
    context,
    sourceInput,
    bundle: null,
    fetcher,
    ...(engine ? { engine } : {}),
  };
}

async function resolveContextBundle(
  input: ResolveInput,
): Promise<ContextBundle | null> {
  try {
    return await fetchOpenWorkContextBundle(input.sourceInput, input.fetcher, input.traceId);
  } catch (error) {
    const failure = classifyOpenWorkContextBundleFailure(error);
    const status = "status" in failure ? ` status=${failure.status}` : "";
    logPromptDebug(
      "context",
      `trace=${input.traceId} context bundle unavailable classification=${failure.classification}${status}`,
    );
    return null;
  }
}

/**
 * Builds the sole OpenCode plugin factory for an ordered contributor registry.
 * The returned factory isolates every contributor so one failure cannot stop
 * later system blocks or hook contributors from running.
 */
export function createContextPlugin(registry: readonly ContextContributor[]): ContextPluginFactory {
  const sorted = sortedRegistry(registry);
  const systemContributors = sorted.filter(
    (contributor): contributor is SystemBlockContributor => contributor.kind === "system-block",
  );
  const paramsContributors = sorted.filter(
    (contributor): contributor is ParamsContributor => contributor.kind === "params",
  );
  const messagesContributors = sorted.filter(
    (contributor): contributor is MessagesContributor => contributor.kind === "messages",
  );
  const hasToolContributors = sorted.some((contributor) => contributor.kind === "tool");

  return async (factoryInput?: unknown) => {
    const factoryContext = normalizeOpenCodeContext(factoryInput);
    const env: ContributorEnv = { env: { ...process.env }, factoryContext };
    const fetcher = readFactoryFetcher(factoryInput);
    const engine = engineSource(factoryInput, factoryContext);
    const tools: Record<string, EngineToolDefinition> = {};
    const toolOrigins = new Map<string, string>();
    const gateEvaluations = new Map<ContextContributor, GateEvaluation>();

    for (const contributor of sorted) {
      gateEvaluations.set(contributor, evaluateContributorGate(contributor, env));
    }

    for (const contributor of sorted) {
      if (contributor.kind !== "tool" && contributor.kind !== "fetch-patch") continue;
      try {
        if (!contributorEnabled(contributor, gateEvaluations)) continue;
        if (contributor.kind === "tool") {
          const resolved = await resolveTools(contributor, env);
          for (const [toolId, definition] of Object.entries(resolved)) {
            const priorContributor = toolOrigins.get(toolId);
            if (priorContributor) {
              console.error(
                `[openwork][context] duplicate tool id=${toolId} contributors=${priorContributor},${contributor.id}; using=${contributor.id}`,
              );
            }
            tools[toolId] = definition;
            toolOrigins.set(toolId, contributor.id);
          }
        } else {
          await installFetchPatch(contributor);
        }
      } catch (error) {
        logContributorFailure(
          contributor,
          contributorFailureStage(
            contributor,
            gateEvaluations,
            contributor.kind === "tool" ? "tool-resolution" : "fetch-patch-install",
          ),
          error,
        );
      }
    }

    const hooks: ContextPluginHooks = {};

    if (systemContributors.length > 0) {
      hooks["experimental.chat.system.transform"] = async (input, output) => {
        const currentInput = resolveInput(input, factoryContext, fetcher, engine);
        currentInput.bundle = await resolveContextBundle(currentInput);
        for (const contributor of systemContributors) {
          try {
            if (!contributorEnabled(contributor, gateEvaluations)) continue;
            const block = await resolveSystemBlock(contributor, currentInput);
            appendSystemBlock(contributor, output, block, currentInput.traceId);
          } catch (error) {
            logContributorFailure(
              contributor,
              contributorFailureStage(contributor, gateEvaluations, "system-block-resolution"),
              error,
              currentInput.traceId,
            );
            if (contributor.onError.mode === "fallback") {
              appendSystemBlock(contributor, output, contributor.onError.text, currentInput.traceId);
            }
          }
        }
      };
    }

    if (hasToolContributors) hooks.tool = tools;

    if (paramsContributors.length > 0) {
      hooks["chat.params"] = async (input, output) => {
        for (const contributor of paramsContributors) {
          try {
            if (!contributorEnabled(contributor, gateEvaluations)) continue;
            contributor.chatParams(input, output);
          } catch (error) {
            logContributorFailure(
              contributor,
              contributorFailureStage(contributor, gateEvaluations, "params-transform"),
              error,
            );
          }
        }
      };
    }

    if (messagesContributors.length > 0) {
      hooks["experimental.chat.messages.transform"] = async (input, output) => {
        for (const contributor of messagesContributors) {
          try {
            if (!contributorEnabled(contributor, gateEvaluations)) continue;
            await contributor.transformMessages(input, output, env);
          } catch (error) {
            logContributorFailure(
              contributor,
              contributorFailureStage(contributor, gateEvaluations, "messages-transform"),
              error,
            );
          }
        }
      };
    }

    return hooks;
  };
}

/** Returns registry metadata without evaluating gates or contributor code. */
export function describeContextRegistry(
  registry: readonly ContextContributor[],
): ContextRegistryDescription[] {
  return sortedRegistry(registry).map((contributor) => ({
    id: contributor.id,
    kind: contributor.kind,
    order: contributor.order,
    gate: contributor.gate ? "contributor-env" : "always",
    gateEnv: [...(contributor.gateEnv ?? [])],
    toolNames: contributor.kind === "tool" ? [...contributor.toolNames] : [],
    cache: contributor.cache.scope === "none"
      ? { scope: "none" }
      : {
          scope: "process",
          ...(contributor.cache.ttlMs === undefined ? {} : { ttlMs: contributor.cache.ttlMs }),
        },
    description: contributor.description,
  }));
}

/** Evaluates gates without exposing gate-returned text or environment values. */
export function evaluateContextRegistryGates(
  registry: readonly ContextContributor[],
  env: ContributorEnv,
): ContextRegistryGateEvaluation[] {
  return sortedRegistry(registry).map((contributor) => {
    if (!contributor.gate) {
      return { id: contributor.id, enabled: true, reason: "always" };
    }
    try {
      const result = contributor.gate(env);
      return result.enabled
        ? { id: contributor.id, enabled: true, reason: "gate_enabled" }
        : { id: contributor.id, enabled: false, reason: "gate_disabled" };
    } catch {
      return { id: contributor.id, enabled: false, reason: "gate_error" };
    }
  });
}
