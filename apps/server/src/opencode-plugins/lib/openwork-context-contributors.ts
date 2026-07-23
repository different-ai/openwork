import { applyAnthropicAdaptiveThinking } from "./anthropic-adaptive-thinking.js";
import { installAnthropicToolSchemaFetchPatch } from "./anthropic-tool-schema.js";
import {
  OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION,
  resolveOpenWorkExtensionDiscoveryInstruction,
} from "./connect-steering.js";
import {
  createOpenWorkCapabilitiesHooks,
  OPENWORK_CAPABILITIES_KNOWLEDGE,
} from "./capabilities-knowledge.js";
import { mergeTransformInputWithFactoryContext } from "./context.js";
import {
  type ContextContributor,
  type ContributorEnv,
  type EngineToolDefinition,
  type ResolveInput,
} from "./context-registry.js";
import { transformOfficeAttachmentMessages } from "./office-attachments.js";
import {
  createOpenWorkPreviewHooks,
  OPENWORK_BROWSER_INSTRUCTION,
  OPENWORK_SESSION_CREATION_INSTRUCTION,
  OPENWORK_SESSION_MEMORY_INSTRUCTION,
  OPENWORK_UI_CONTROL_INSTRUCTION,
  uiControlToolsEnabled,
} from "./preview-context.js";

const NO_CACHE = { scope: "none" } as const;
const PROCESS_CACHE = { scope: "process" } as const;
const OMIT_ON_ERROR = { mode: "omit" } as const;

const EXTENSION_TOOL_NAMES = [
  "openwork_extension_list_actions",
  "openwork_extension_call",
] as const;

const UI_CONTROL_TOOL_NAMES = [
  "openwork_ui_snapshot",
  "openwork_ui_list_actions",
  "openwork_ui_execute_action",
] as const;

const SESSION_TOOL_NAMES = [
  "openwork_session_create",
  "openwork_session_search",
  "openwork_session_read",
] as const;

const EXTENSIONS_EXPORT_TOOL_NAMES = ["openwork_extensions_export"] as const;

const BROWSER_TOOL_NAMES = [
  "openwork_browser_open_url",
  "openwork_browser_set_proxy",
  "openwork_browser_clear_proxy",
] as const;

const DOCS_TOOL_NAMES = ["openwork_docs_search", "openwork_docs_read"] as const;

function uiControlGate({ env }: ContributorEnv) {
  return uiControlToolsEnabled(env)
    ? { enabled: true as const }
    : {
        enabled: false as const,
        reason: "OPENWORK_UI_CONTROL_TOOLS is not enabled",
      };
}

function contributorTransformInput(input: ResolveInput): unknown {
  return mergeTransformInputWithFactoryContext(input.sourceInput, input.context);
}

async function resolveConnectSteering(input: ResolveInput): Promise<string> {
  return resolveOpenWorkExtensionDiscoveryInstruction(
    contributorTransformInput(input),
    input.fetcher,
    input.engine,
    input.bundle?.steering ?? undefined,
  );
}

function resolveConnectSkills(input: ResolveInput): string | null {
  return input.bundle?.skills.instruction || null;
}

function previewTools(env: ContributorEnv): Record<string, EngineToolDefinition> {
  return createOpenWorkPreviewHooks(env.factoryContext, env.env).tool;
}

function docsTools(): Record<string, EngineToolDefinition> {
  return createOpenWorkCapabilitiesHooks().tool;
}

function pickTools(
  source: Record<string, EngineToolDefinition>,
  names: readonly string[],
): Record<string, EngineToolDefinition> {
  const selected: Record<string, EngineToolDefinition> = {};
  for (const name of names) {
    const definition = source[name];
    if (definition) selected[name] = definition;
  }
  return selected;
}

/**
 * The canonical, explicitly ordered OpenWork context registry.
 *
 * Orders intentionally leave gaps for future contributors.
 */
export const OPENWORK_CONTEXT_REGISTRY: readonly ContextContributor[] = [
  {
    id: "connect-steering",
    order: 10,
    kind: "system-block",
    description: "Select Connect steering from the engine MCP status, then the OpenWork server fallback.",
    cache: NO_CACHE,
    onError: { mode: "fallback", text: OPENWORK_EXTENSION_DISCOVERY_INSTRUCTION },
    resolve: resolveConnectSteering,
  },
  {
    id: "connect-skills",
    order: 20,
    kind: "system-block",
    description: "Inject the server/account-scoped OpenWork Connect skill catalog when non-empty.",
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: resolveConnectSkills,
  },
  {
    id: "session-creation",
    order: 30,
    kind: "system-block",
    description: "Explain how to create background OpenWork sessions.",
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: () => OPENWORK_SESSION_CREATION_INSTRUCTION,
  },
  {
    id: "session-memory",
    order: 40,
    kind: "system-block",
    description: "Explain how to search and read saved OpenWork sessions.",
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: () => OPENWORK_SESSION_MEMORY_INSTRUCTION,
  },
  {
    id: "browser-guidance",
    order: 50,
    kind: "system-block",
    description: "Route external web tasks through the OpenWork built-in browser bridge.",
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: () => OPENWORK_BROWSER_INSTRUCTION,
  },
  {
    id: "ui-control-guidance",
    order: 60,
    kind: "system-block",
    description: "Explain how to control the OpenWork desktop UI when its preview surface is enabled.",
    gate: uiControlGate,
    gateEnv: ["OPENWORK_UI_CONTROL_TOOLS"],
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: () => OPENWORK_UI_CONTROL_INSTRUCTION,
  },
  {
    id: "capabilities-knowledge",
    order: 70,
    kind: "system-block",
    description: "Describe OpenWork product capabilities and product-help routing.",
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    resolve: () => OPENWORK_CAPABILITIES_KNOWLEDGE,
  },
  {
    id: "extension-tools",
    order: 100,
    kind: "tool",
    description: "List and execute actions exposed by OpenWork extensions.",
    toolNames: EXTENSION_TOOL_NAMES,
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    tools: (env) => pickTools(previewTools(env), EXTENSION_TOOL_NAMES),
  },
  {
    id: "ui-control-tools",
    order: 110,
    kind: "tool",
    description: "Inspect and execute OpenWork desktop UI actions when explicitly enabled.",
    toolNames: UI_CONTROL_TOOL_NAMES,
    gate: uiControlGate,
    gateEnv: ["OPENWORK_UI_CONTROL_TOOLS"],
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    tools: (env) => pickTools(previewTools(env), UI_CONTROL_TOOL_NAMES),
  },
  {
    id: "session-tools",
    order: 120,
    kind: "tool",
    description: "Create, search, and read OpenWork sessions without UI navigation.",
    toolNames: SESSION_TOOL_NAMES,
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    tools: (env) => pickTools(previewTools(env), SESSION_TOOL_NAMES),
  },
  {
    id: "extensions-export-tool",
    order: 130,
    kind: "tool",
    description: "Export portable skill and MCP definitions with secrets redacted.",
    toolNames: EXTENSIONS_EXPORT_TOOL_NAMES,
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    tools: (env) => pickTools(previewTools(env), EXTENSIONS_EXPORT_TOOL_NAMES),
  },
  {
    id: "browser-tools",
    order: 140,
    kind: "tool",
    description: "Open built-in browser tabs and configure their proxy.",
    toolNames: BROWSER_TOOL_NAMES,
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    tools: (env) => pickTools(previewTools(env), BROWSER_TOOL_NAMES),
  },
  {
    id: "docs-tools",
    order: 150,
    kind: "tool",
    description: "Search and read the bundled OpenWork documentation.",
    toolNames: DOCS_TOOL_NAMES,
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    tools: () => pickTools(docsTools(), DOCS_TOOL_NAMES),
  },
  {
    id: "office-attachments",
    order: 200,
    kind: "messages",
    description: "Normalize DOCX, PPTX, and XLSX attachments before provider dispatch.",
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    transformMessages: (_input, output, env) => transformOfficeAttachmentMessages(env.factoryContext, output),
  },
  {
    id: "adaptive-thinking",
    order: 210,
    kind: "params",
    description: "Rewrite legacy extended-thinking parameters for Claude 5-family models.",
    cache: NO_CACHE,
    onError: OMIT_ON_ERROR,
    chatParams: applyAnthropicAdaptiveThinking,
  },
  {
    id: "anthropic-tool-schema",
    order: 220,
    kind: "fetch-patch",
    description: "Flatten unsupported top-level Anthropic tool-schema combinators before dispatch.",
    cache: PROCESS_CACHE,
    onError: OMIT_ON_ERROR,
    install: installAnthropicToolSchemaFetchPatch,
  },
];
