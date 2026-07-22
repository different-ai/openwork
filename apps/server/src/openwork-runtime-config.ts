/**
 * Runtime OpenCode configuration injected via a server-managed config file
 * passed to the engine as OPENCODE_CONFIG.
 *
 * This is the single source of truth for the openwork agent definition,
 * plugins, and any other config that should be injected at runtime rather
 * than written to the user's own config files. Both cli.ts and embedded.ts
 * use this.
 *
 * The engine re-reads the OPENCODE_CONFIG file from disk on every instance
 * rebuild (e.g. /instance/dispose), so the file is rewritten on every
 * runtime-DB write — unlike the previous OPENCODE_CONFIG_CONTENT env var,
 * which was frozen at spawn and reverted MCP state on each dispose.
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  openworkExtensionsPreviewPluginPath,
  openworkCapabilitiesKnowledgePluginPath,
  openworkAnthropicAdaptiveThinkingPluginPath,
  openworkAnthropicToolSchemaPluginPath,
  openworkOfficeAttachmentsPluginPath,
} from "./openwork-extensions-plugin-path.js";
import type { ServerConfig } from "./types.js";
import {
  onRuntimeOpencodeConfigWrite,
  readRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeMcpMap,
  runtimePluginList,
  runtimeStorageDir,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";

const OPENWORK_AGENT_PROMPT = `You are OpenWork.

When the user refers to "you", they mean the OpenWork app and the current workspace.

Your job:
- Help the user work on files safely.
- Automate repeatable work.
- Keep behavior portable and reproducible.

## Memory

Two kinds:
1. Behavior memory (shareable, in git): .opencode/skills/**, .opencode/agents/**, repo docs
2. Private memory (never commit): tokens, credentials, local config, logs

Hard rule: never copy private memory into repo files. Store only redacted summaries, schemas, and stable pointers.

## Working style

- If required setup or credentials are missing, ask one targeted question and continue once provided.
- If you change code, run the smallest meaningful test.
- If steps repeat, factor them into a skill.
- Prefer clear, practical steps over abstract explanations.

## OpenWork Artifacts

OpenWork can preview, edit, and download standard artifacts when you create or update them in the workspace.

- Prefer standard output files for user-visible deliverables: Markdown (.md), CSV (.csv), Excel workbooks (.xlsx), PowerPoint decks (.pptx), and browser previews (index.html or a local http://localhost:<port> URL).
- After creating or updating an artifact, mention the exact workspace-relative file path in your final response, for example reports/artifact-eval.md or reports/artifact-eval.xlsx.
- Do not invent Workspace/<id>/... paths unless a tool returns them; prefer clean workspace-relative paths.
- For websites or React/UI previews, start the dev server when useful and mention the http://localhost:<port> URL.
- For spreadsheets, use .csv for simple tabular data and .xlsx when the user asks for Excel/XLS specifically.

## Memory Bank

The memory bank is a per-user store of durable facts, reached through the meta-MCP. It is NOT a local file — never write memories to .opencode/ or any file. There is no dedicated memory tool: to save or recall a memory, first discover the capability with search_capabilities, then run it with execute_capability — i.e. search for a capability to save a memory, then execute it. The capabilities you find are named like postMemory (save), getMemorySearch (search), getMemory (list), and deleteMemoryById (delete).

Save flow:
- Draft a candidate memory: a crisp, self-contained content sentence, plus optional cited contexts (a snippet, each with an optional conversation_id/message_id).
- Show the draft and get the human to confirm or edit it, and flag anything that looks like a secret or personal detail so they can remove it first. Only persist human-confirmed content, never raw agent output.
- Once confirmed, search for a capability to save a memory (postMemory) and execute it with a body like { "content": "…" }.

Retrieval flow:
- When the user asks in natural language, search for a capability to search memories (getMemorySearch) and execute it with their phrasing as the query q.
- Reduce the results to what is relevant and present them. Recall is explicit and lexical: only search when asked, never auto-recall, and do not claim to understand meaning.

Manage: to show what is saved, discover and execute the list capability (getMemory); to remove one, discover and execute the delete capability (deleteMemoryById) after confirming with the human.

Never persist secrets, credentials, API keys, tokens, or sensitive PII into a memory. This applies to both the content sentence and any cited snippets — redact secrets from a snippet before saving it.`;

export async function buildOpenworkRuntimeConfigObject(
  config?: ServerConfig,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  const runtimeConfig = config && workspaceId ? await readRuntimeOpencodeConfig(config, workspaceId) : {};
  return buildOpenworkRuntimeConfigObjectFromSnapshot(runtimeConfig);
}

export function buildOpenworkRuntimeConfigObjectFromSnapshot(
  runtimeConfig: RuntimeOpencodeConfig,
): Record<string, unknown> {
  const disabledProviders = runtimeDisabledProviderList(runtimeConfig);
  return {
    ...runtimeConfig,
    default_agent: runtimeConfig.default_agent ?? "openwork",
    agent: {
      openwork: {
        description: "OpenWork default agent",
        mode: "primary",
        temperature: 0.2,
        prompt: OPENWORK_AGENT_PROMPT,
      },
    },
    plugin: [
      "opencode-chrome-devtools",
      openworkExtensionsPreviewPluginPath(),
      openworkCapabilitiesKnowledgePluginPath(),
      openworkOfficeAttachmentsPluginPath(),
      openworkAnthropicAdaptiveThinkingPluginPath(),
      openworkAnthropicToolSchemaPluginPath(),
      ...runtimePluginList(runtimeConfig),
    ],
    ...(disabledProviders.length ? { disabled_providers: disabledProviders } : {}),
    mcp: runtimeMcpMap(runtimeConfig),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableJsonValue(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export async function buildOpenworkRuntimeConfig(config?: ServerConfig, workspaceId?: string): Promise<string> {
  return stableStringify(await buildOpenworkRuntimeConfigObject(config, workspaceId));
}

export function openworkRuntimeConfigFilePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), "runtime-opencode-config.json");
}

// Serialize file writes per path so a slow older write can never land after
// (and clobber) a newer one. Content is built inside the queued job so each
// job reads the latest runtime-DB state.
const fileWriteQueue = new Map<string, Promise<void>>();

/**
 * Rebuild the engine-visible runtime config file from the runtime DB.
 * Atomic (temp file + rename) so the engine never reads a partial file
 * mid-dispose.
 */
export async function writeOpenworkRuntimeConfigFile(config: ServerConfig, workspaceId: string): Promise<string> {
  const path = openworkRuntimeConfigFilePath(config);
  const job = async () => {
    const content = await buildOpenworkRuntimeConfig(config, workspaceId);
    await mkdir(runtimeStorageDir(config), { recursive: true });
    const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  };
  const previous = fileWriteQueue.get(path) ?? Promise.resolve();
  const next = previous.then(job, job);
  fileWriteQueue.set(path, next);
  await next;
  return path;
}

/**
 * Keep the runtime config file in sync with the runtime DB so every engine
 * instance rebuild reads fresh state instead of a spawn-time snapshot.
 * Returns an unsubscribe function.
 */
export function keepOpenworkRuntimeConfigFileFresh(config: ServerConfig, workspaceId: string): () => void {
  return onRuntimeOpencodeConfigWrite((writeConfig, writtenWorkspaceId) => {
    if (writtenWorkspaceId !== workspaceId) return;
    void writeOpenworkRuntimeConfigFile(writeConfig, workspaceId).catch(() => undefined);
  });
}
