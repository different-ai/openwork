"use client";

import { AUTO_ROUTER_THINKING_LABELS, autoRouterThinkingLevelSchema, type AutoRouterThinkingLevel } from "@openwork/types/den/auto-router";
import { CLAUDE_CODE_LONG_CONTEXT, claudeCodeBaseUrl, claudeDesktopListsModel, codexBaseUrl, cursorBaseUrl } from "@openwork/types/den/gateway-cursor";
import { Check, ChevronLeft, ChevronRight, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenSelect } from "../../_components/ui/select";
import { claudeCodeToolModelName, claudeModelId, gatewayToolModelLabel, gatewayToolModelName, useGatewayToolModels, type GatewayToolModel } from "./cursor-setup-data";
import { GATEWAY_API_KEYS_DOCS_URL } from "./gateway-api-keys-data";

/**
 * Setting up a 3rd party tool with an AI Gateway API key: a choice of
 * tools, then what to paste where for the one picked. Used right after a key is created, while it can
 * still be shown, and on Set up Cursor without a key.
 */

export type GatewayToolId = "cursor" | "codex" | "codex-app" | "claude-code" | "claude-desktop" | "other";

type GatewayTool = { id: GatewayToolId; name: string; slug?: string; serviceUrl?: string; line: string };

export const GATEWAY_TOOLS: readonly GatewayTool[] = [
  { id: "cursor", name: "Cursor", slug: "cursor", serviceUrl: "https://cursor.com", line: "Every model, in Cursor's chat and agent" },
  { id: "codex", name: "OpenAI Codex", slug: "openai", serviceUrl: "https://openai.com", line: "Every model, in the Codex CLI" },
  { id: "codex-app", name: "Codex app", slug: "openai", serviceUrl: "https://openai.com", line: "Every model, in Codex in the ChatGPT app" },
  { id: "claude-code", name: "Claude Code", slug: "claude", serviceUrl: "https://claude.com", line: "Every model, in Claude Code" },
  { id: "claude-desktop", name: "Claude Desktop", slug: "claude", serviceUrl: "https://claude.com", line: "Your Claude models, in the Claude app" },
  { id: "other", name: "Another tool", line: "Any OpenAI or Anthropic compatible tool" },
];

export const CURSOR_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/cursor";
export const CLAUDE_CODE_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/claude-code";
export const CODEX_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/codex";
export const CODEX_APP_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/codex-desktop";
export const CLAUDE_DESKTOP_DOCS_URL = "https://openworklabs.com/docs/ai-gateway/claude-desktop";

/** The large choice of tools under "Start using this key". */
export function GatewayToolPicker({ onPick }: { onPick: (tool: GatewayToolId) => void }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" data-testid="gateway-tool-picker">
      {GATEWAY_TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          onClick={() => onPick(tool.id)}
          data-gateway-tool={tool.id}
          data-testid={`gateway-tool-${tool.id}`}
          className="group flex min-h-[72px] items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-left transition-colors hover:border-gray-300 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
        >
          <DenBrandMark name={tool.name} simpleIconSlug={tool.slug} serviceUrl={tool.serviceUrl} className="h-9 w-9 rounded-[10px]" imageClassName="h-[18px] w-[18px]" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-medium leading-5 text-gray-900">{tool.name}</span>
            <span className="block text-[12px] leading-4 text-gray-500">{tool.line}</span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-gray-400 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </button>
      ))}
    </div>
  );
}

export function BackButton({ onClick, label = "Choose another tool" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" onClick={onClick} className="inline-flex w-fit items-center gap-1 text-[13px] text-gray-500 transition-colors hover:text-gray-900">
      <ChevronLeft size={14} aria-hidden />
      {label}
    </button>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => void copy()}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900"
    >
      {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
    </button>
  );
}

/** A value to paste, with a copy button. `multiline` keeps line breaks (config files, shell lines). */
export function CopyField({ value, label, testId, multiline = false }: { value: string; label: string; testId?: string; multiline?: boolean }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5">
      <code className={`min-w-0 flex-1 py-1 font-mono text-[12px] leading-5 text-gray-900 ${multiline ? "overflow-x-auto whitespace-pre" : "break-all"}`} data-testid={testId}>{value}</code>
      <CopyButton value={value} label={label} />
    </div>
  );
}

/** One numbered step: a line of instruction and, below it, what to paste. */
export function SetupStep({ number, children, field }: { number: number; children: ReactNode; field?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-medium tabular-nums text-gray-600">{number}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2 text-[13px] leading-5 text-gray-600">
        <p>{children}</p>
        {field}
      </div>
    </li>
  );
}

function Strong({ children }: { children: ReactNode }) {
  return <b className="font-medium text-gray-900">{children}</b>;
}

/** The key to paste, when there is one to show; otherwise a pointer to where it was copied. */
function KeyField({ apiKey }: { apiKey: string | null }) {
  return apiKey ? <CopyField value={apiKey} label="Copy API key" testId="gateway-tool-api-key" /> : null;
}

function DocsLink({ href }: { href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="w-fit text-[12px] text-gray-600 underline underline-offset-4 hover:text-gray-900">
      Read the full guide
    </a>
  );
}

function ModelsState({ loading, error, empty }: { loading: boolean; error: Error | null; empty: string | null }) {
  if (loading) return <p className="text-[13px] text-gray-500">Loading your models...</p>;
  if (error) return <p className="text-[13px] text-red-600" role="alert">{error.message}</p>;
  if (empty) return <p className="text-[13px] text-gray-500" data-testid="gateway-tool-models-empty">{empty}</p>;
  return null;
}

/** Choose a model (and its thinking level, when it has levels); the name to copy follows the choice. */
function CursorModelPicker({ models }: { models: readonly GatewayToolModel[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [thinking, setThinking] = useState<AutoRouterThinkingLevel>("default");
  const model = models.find((entry) => entry.modelId === selected) ?? models[0] ?? null;
  if (!model) return null;
  const level = model.thinkingLevels.includes(thinking) ? thinking : "default";
  const name = gatewayToolModelName(model, level);
  return (
    <div className="flex flex-col gap-2" data-cursor-model={model.name}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <span className="min-w-0 flex-1">
          <DenSelect value={model.modelId} aria-label="Model" onChange={(event) => setSelected(event.target.value)}>
            {models.map((entry) => <option key={entry.modelId} value={entry.modelId}>{gatewayToolModelLabel(entry)}</option>)}
          </DenSelect>
        </span>
        {model.thinkingLevels.length > 1 ? (
          <span className="sm:w-44">
            <DenSelect
              value={level}
              aria-label="Thinking level"
              onChange={(event) => {
                const next = autoRouterThinkingLevelSchema.safeParse(event.target.value);
                if (next.success) setThinking(next.data);
              }}
            >
              {model.thinkingLevels.map((entry) => (
                <option key={entry} value={entry}>{entry === "default" ? "Default thinking" : `${AUTO_ROUTER_THINKING_LABELS[entry]} thinking`}</option>
              ))}
            </DenSelect>
          </span>
        ) : null}
      </div>
      <CopyField value={name} label={`Copy the Cursor name for ${model.name}`} testId="cursor-model-name" />
    </div>
  );
}

/**
 * Cursor: its OpenAI key and base URL override, then one name per model to add. `apiKey` is the
 * key just created, or null on Set up Cursor (where `keyStep` says how to get one).
 */
export function CursorSteps({ apiKey, baseUrl, keyStep }: { apiKey: string | null; baseUrl: string; keyStep?: ReactNode }) {
  const models = useGatewayToolModels(true);
  const list = models.data ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-cursor">
      <ol className="flex flex-col gap-4">
        <SetupStep number={1}>In Cursor, open <Strong>Settings › Models</Strong> and expand <Strong>API Keys</Strong>.</SetupStep>
        <SetupStep number={2} field={apiKey ? <KeyField apiKey={apiKey} /> : keyStep}>Turn on <Strong>OpenAI API Key</Strong> and paste {apiKey ? "this key" : "your API key"}.</SetupStep>
        <SetupStep number={3} field={<CopyField value={cursorBaseUrl(baseUrl)} label="Copy base URL" testId="cursor-setup-base-url-value" />}>
          Turn on <Strong>Override OpenAI Base URL</Strong> and paste:
        </SetupStep>
        <SetupStep
          number={4}
          field={(
            <div className="flex flex-col gap-2" data-testid="cursor-setup-models">
              <ModelsState loading={models.isLoading} error={models.error} empty={models.data && list.length === 0 ? "Your organization hasn't given you any models yet." : null} />
              <CursorModelPicker models={list} />
            </div>
          )}
        >
          Under <Strong>Models</Strong>, select <Strong>Add model</Strong> and paste the name below. Choose another model here and repeat for each one you want.
        </SetupStep>
        <SetupStep number={5}>
          Pick the model in Cursor&apos;s model picker and run the agent in <Strong>Local</Strong> mode (on <Strong>This Mac</Strong>), not <Strong>Cloud</Strong>: Cursor&apos;s cloud agents don&apos;t work with OpenWork models yet.
        </SetupStep>
      </ol>
      <p className="text-[12px] leading-4 text-gray-500">Cursor doesn&apos;t send a thinking level, so it&apos;s part of the name. Add a model once per level to switch between them.</p>
      <DocsLink href={CURSOR_DOCS_URL} />
    </div>
  );
}

/** A choice of model that fills the snippets below it, or a note when the tool can't use any. */
function ModelSnippet({ models, loading, error, empty, children }: {
  models: readonly GatewayToolModel[];
  loading: boolean;
  error: Error | null;
  empty: string;
  children: (model: GatewayToolModel | null) => ReactNode;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const model = models.find((entry) => entry.alias === selected) ?? models[0] ?? null;
  return (
    <>
      <ModelsState loading={loading} error={error} empty={!loading && !error && models.length === 0 ? empty : null} />
      {models.length > 1 ? (
        <DenSelect value={model?.alias ?? ""} aria-label="Model" onChange={(event) => setSelected(event.target.value)}>
          {models.map((entry) => <option key={entry.alias} value={entry.alias}>{gatewayToolModelLabel(entry)}</option>)}
        </DenSelect>
      ) : null}
      {children(model)}
    </>
  );
}

/** Where Codex's `auth` command reads the key: the shell's OPENWORK_API_KEY, or the macOS Keychain item the Codex app steps save. */
export type CodexKeySource = "env" | "keychain";

/** The macOS Keychain item (service name) holding the key for the Codex app. */
export const CODEX_KEYCHAIN_SERVICE = "openwork-ai-gateway";

/** The command that saves the key in the macOS Keychain, replacing an earlier one. */
export function codexKeychainCommand(apiKey: string | null) {
  return `security add-generic-password -U -a "$USER" -s ${CODEX_KEYCHAIN_SERVICE} -w "${apiKey ?? "<your API key>"}"`;
}

/**
 * `~/.codex/config.toml` for Codex (the CLI and the app read the same file): an `openwork` provider on
 * the Gateway's Codex endpoint that gets the key from a command (so Codex also loads the model catalog
 * for /model), the chosen model, and its reasoning effort when one is chosen.
 */
export function codexConfig(input: { baseUrl: string; model: GatewayToolModel; thinking: AutoRouterThinkingLevel; keySource?: CodexKeySource }) {
  const auth = input.keySource === "keychain"
    ? [`command = "/usr/bin/security"`, `args = ["find-generic-password", "-s", "${CODEX_KEYCHAIN_SERVICE}", "-w"]`]
    : [`command = "sh"`, `args = ["-c", "echo $OPENWORK_API_KEY"]`];
  return [
    `model_provider = "openwork"`,
    `model = "${gatewayToolModelName(input.model)}"`,
    ...(input.thinking === "default" ? [] : [`model_reasoning_effort = "${input.thinking}"`]),
    ``,
    `[model_providers.openwork]`,
    `name = "OpenWork"`,
    `base_url = "${codexBaseUrl(input.baseUrl)}"`,
    `wire_api = "responses"`,
    ``,
    `[model_providers.openwork.auth]`,
    ...auth,
  ].join("\n");
}

/** Choose a model and thinking level; the config.toml to paste follows the choice. */
function CodexConfigField({ baseUrl, keySource, testId }: { baseUrl: string; keySource: CodexKeySource; testId: string }) {
  const models = useGatewayToolModels(true);
  const list = models.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [thinking, setThinking] = useState<AutoRouterThinkingLevel>("default");
  const model = list.find((entry) => entry.modelId === selected) ?? list[0] ?? null;
  const level = model?.thinkingLevels.includes(thinking) ? thinking : "default";
  return (
    <div className="flex flex-col gap-2">
      <ModelsState loading={models.isLoading} error={models.error} empty={models.data && list.length === 0 ? "Your organization hasn't given you any models yet." : null} />
      {model ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <span className="min-w-0 flex-1">
              <DenSelect value={model.modelId} aria-label="Model" onChange={(event) => setSelected(event.target.value)}>
                {list.map((entry) => <option key={entry.modelId} value={entry.modelId}>{gatewayToolModelLabel(entry)}</option>)}
              </DenSelect>
            </span>
            {model.thinkingLevels.length > 1 ? (
              <span className="sm:w-44">
                <DenSelect
                  value={level}
                  aria-label="Thinking level"
                  onChange={(event) => {
                    const next = autoRouterThinkingLevelSchema.safeParse(event.target.value);
                    if (next.success) setThinking(next.data);
                  }}
                >
                  {model.thinkingLevels.map((entry) => (
                    <option key={entry} value={entry}>{entry === "default" ? "Default thinking" : `${AUTO_ROUTER_THINKING_LABELS[entry]} thinking`}</option>
                  ))}
                </DenSelect>
              </span>
            ) : null}
          </div>
          <CopyField multiline label="Copy the Codex configuration" testId={testId} value={codexConfig({ baseUrl, model, thinking: level, keySource })} />
        </>
      ) : null}
    </div>
  );
}

/** OpenAI Codex CLI: the key in the shell profile, and a provider in ~/.codex/config.toml. */
export function CodexSteps({ apiKey, baseUrl }: { apiKey: string | null; baseUrl: string }) {
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-codex">
      <ol className="flex flex-col gap-4">
        <SetupStep number={1} field={<CopyField value={`export OPENWORK_API_KEY="${apiKey ?? "<your API key>"}"`} label="Copy the key line" testId="gateway-tool-codex-env" />}>
          Add this line to your shell profile (for example <Strong>~/.zshrc</Strong>), then open a new terminal:
        </SetupStep>
        <SetupStep number={2} field={<CodexConfigField baseUrl={baseUrl} keySource="env" testId="gateway-tool-codex-config" />}>
          Choose a model, then put this at the top of <Strong>~/.codex/config.toml</Strong>, replacing any <Strong>model</Strong> or <Strong>model_provider</Strong> lines already there:
        </SetupStep>
        <SetupStep number={3} field={<CopyField value="codex app-server daemon restart" label="Copy the restart command" testId="gateway-tool-codex-restart" />}>
          In a new terminal, restart Codex&apos;s background server so it picks up the key and config. Do this again whenever you change either:
        </SetupStep>
        <SetupStep number={4} field={<CopyField value="codex" label="Copy the command" />}>
          Start Codex in your project. Run <Strong>/status</Strong> to check it uses OpenWork; <Strong>/model</Strong> switches between your models.
        </SetupStep>
      </ol>
      <DocsLink href={CODEX_DOCS_URL} />
    </div>
  );
}

/**
 * Codex in the ChatGPT desktop app (macOS): the key in the Keychain, since an app opened from the
 * Dock has no shell profile, and the same ~/.codex/config.toml as the CLI with an auth command that
 * reads it. The app keeps the key and config it started with until it is quit.
 */
export function CodexAppSteps({ apiKey, baseUrl }: { apiKey: string | null; baseUrl: string }) {
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-codex-app">
      <ol className="flex flex-col gap-4">
        <SetupStep number={1} field={<CopyField value={codexKeychainCommand(apiKey)} label="Copy the Keychain command" testId="gateway-tool-codex-app-keychain" />}>
          Save your key in the macOS Keychain. Run this in Terminal:
        </SetupStep>
        <SetupStep number={2} field={<CodexConfigField baseUrl={baseUrl} keySource="keychain" testId="gateway-tool-codex-app-config" />}>
          Choose a model, then put this at the top of <Strong>~/.codex/config.toml</Strong>, replacing any <Strong>model</Strong> or <Strong>model_provider</Strong> lines already there:
        </SetupStep>
        <SetupStep number={3}>
          Quit ChatGPT completely with <Strong>⌘Q</Strong> (closing the window isn&apos;t enough) and open it again. Do this whenever you change the key or config.
        </SetupStep>
        <SetupStep number={4}>
          In Codex, pick your model in the model menu under the message box.
        </SetupStep>
      </ol>
      <p className="text-[12px] leading-4 text-gray-500">On Windows, follow the guide instead.</p>
      <DocsLink href={CODEX_APP_DOCS_URL} />
    </div>
  );
}

const claudeCodeName = claudeCodeToolModelName;

/**
 * The best first choice for Claude Code's main model: a Claude Opus or Sonnet when there is one. Smart
 * Routers are offered but never picked first.
 */
function preferredMain(all: readonly GatewayToolModel[]) {
  const models = all.filter((model) => model.smartRouterName === null);
  return models.find((model) => /opus/i.test(model.name)) ?? models.find((model) => /sonnet/i.test(model.name)) ?? models.find((model) => claudeModelId(model)) ?? models[0] ?? all[0] ?? null;
}

function preferredFast(all: readonly GatewayToolModel[]) {
  const models = all.filter((model) => model.smartRouterName === null);
  return models.find((model) => /haiku/i.test(model.name)) ?? models.find((model) => /mini|flash|nano|small/i.test(model.name)) ?? null;
}

/**
 * `.claude/settings.local.json` for a project: the Gateway's Claude Code endpoint and key, the main
 * model for Claude Code's Opus and Sonnet slots (and subagents), and the fast model for its Haiku
 * slot. Claude models are also mapped to Claude Code's own ids so it knows their limits and
 * features; another model gets its context window spelled out. A Smart Router is neither: no
 * mapping, no `[1m]`, no window.
 */
export function claudeCodeSettings(input: { apiKey: string | null; baseUrl: string; main: GatewayToolModel; fast: GatewayToolModel }) {
  const main = claudeCodeName(input.main);
  const fast = claudeCodeName(input.fast);
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: claudeCodeBaseUrl(input.baseUrl),
    ANTHROPIC_AUTH_TOKEN: input.apiKey ?? "<your API key>",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_DEFAULT_OPUS_MODEL: main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
    CLAUDE_CODE_SUBAGENT_MODEL: main,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };
  const context = input.main.contextWindow;
  if (!claudeModelId(input.main) && context && context !== 200_000 && context < CLAUDE_CODE_LONG_CONTEXT) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(context);
  const overrides: Record<string, string> = {};
  for (const [model, name] of [[input.main, main], [input.fast, fast]] as const) {
    const id = claudeModelId(model);
    if (id) overrides[id] = name;
  }
  return JSON.stringify({ env, ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {}) }, null, 2);
}

function ModelChoice({ label, models, value, onChange }: { label: string; models: readonly GatewayToolModel[]; value: GatewayToolModel; onChange: (modelId: string) => void }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-[12px] text-gray-500">{label}</span>
      <DenSelect value={value.modelId} aria-label={label} onChange={(event) => onChange(event.target.value)}>
        {models.map((entry) => <option key={entry.modelId} value={entry.modelId}>{gatewayToolModelLabel(entry)}</option>)}
      </DenSelect>
    </label>
  );
}

/** Claude Code: a project settings file that points it at the Gateway's Claude Code endpoint. */
export function ClaudeCodeSteps({ apiKey, baseUrl }: { apiKey: string | null; baseUrl: string }) {
  const models = useGatewayToolModels(true);
  const list = models.data ?? [];
  const [mainId, setMainId] = useState<string | null>(null);
  const [fastId, setFastId] = useState<string | null>(null);
  const main = list.find((model) => model.modelId === mainId) ?? preferredMain(list);
  const fast = list.find((model) => model.modelId === fastId) ?? preferredFast(list) ?? main;
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-claude-code">
      <ol className="flex flex-col gap-4">
        <SetupStep
          number={1}
          field={(
            <div className="flex flex-col gap-2">
              <ModelsState loading={models.isLoading} error={models.error} empty={models.data && list.length === 0 ? "Your organization hasn't given you any models yet." : null} />
              {main && fast ? (
                <>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <ModelChoice label="Main model" models={list} value={main} onChange={setMainId} />
                    <ModelChoice label="Fast model" models={list} value={fast} onChange={setFastId} />
                  </div>
                  <CopyField multiline label="Copy the Claude Code settings" testId="gateway-tool-claude-code-settings" value={claudeCodeSettings({ apiKey, baseUrl, main, fast })} />
                </>
              ) : null}
            </div>
          )}
        >
          In your project folder, create <Strong>.claude/settings.local.json</Strong> with this. It holds your key, so keep it out of git.
        </SetupStep>
        <SetupStep number={2} field={<CopyField value="claude" label="Copy the command" />}>
          Start Claude Code in that folder. Using it on this computer for the first time? Start it once with <Strong>ANTHROPIC_AUTH_TOKEN=&quot;&lt;your key&gt;&quot; claude</Strong> so it skips the Anthropic sign-in.
        </SetupStep>
        <SetupStep number={3}>
          Run <Strong>/status</Strong>: it should show the OpenWork base URL. If it shows a Claude account instead, run <Strong>/logout</Strong> and start Claude Code again. <Strong>/model</Strong> switches between your models.
        </SetupStep>
      </ol>
      <p className="text-[12px] leading-4 text-gray-500">Claude Code works best with Claude models. Other models work too, through the same settings.</p>
      <DocsLink href={CLAUDE_CODE_DOCS_URL} />
    </div>
  );
}

/**
 * Claude Desktop in Gateway mode: its third-party inference settings point at the Gateway's Claude
 * Code endpoint with the key. Its model picker lists only Claude models, so the last step names the
 * ones this person will see.
 */
export function ClaudeDesktopSteps({ apiKey, baseUrl }: { apiKey: string | null; baseUrl: string }) {
  const models = useGatewayToolModels(true);
  const shown = (models.data ?? []).filter((model) => claudeDesktopListsModel(claudeCodeName(model)));
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-claude-desktop">
      <ol className="flex flex-col gap-4">
        <SetupStep number={1}>In Claude Desktop, open <Strong>Help › Troubleshooting › Enable Developer Mode</Strong>. You don&apos;t need to sign in.</SetupStep>
        <SetupStep number={2}>Open <Strong>Developer › Configure Third-Party Inference…</Strong> and set <Strong>Connection</Strong> to <Strong>Gateway</Strong>.</SetupStep>
        <SetupStep
          number={3}
          field={(
            <div className="flex flex-col gap-2">
              <CopyField value={claudeCodeBaseUrl(baseUrl)} label="Copy Gateway base URL" testId="gateway-tool-claude-desktop-base-url" />
              <CopyField value={apiKey ?? "<your API key>"} label="Copy Gateway API key" testId="gateway-tool-claude-desktop-api-key" />
            </div>
          )}
        >
          Set <Strong>Credential kind</Strong> to <Strong>Static API key</Strong>, <Strong>Gateway auth scheme</Strong> to <Strong>bearer</Strong>, and paste the <Strong>Gateway base URL</Strong> and <Strong>Gateway API key</Strong>. Leave the sign-in (OIDC) fields empty.
        </SetupStep>
        <SetupStep number={4}>
          Select <Strong>Apply Changes</Strong>, then <Strong>Relaunch now</Strong>. If Claude asks how to continue, choose <Strong>Continue with Gateway</Strong>.
        </SetupStep>
        <SetupStep
          number={5}
          field={(
            <div className="flex flex-col gap-2" data-testid="gateway-tool-claude-desktop-models">
              <ModelsState
                loading={models.isLoading}
                error={models.error}
                empty={models.data && shown.length === 0 ? "Claude Desktop only lists Claude models, and your organization hasn't given you one yet." : null}
              />
              {shown.length > 0 ? <p className="text-[13px] text-gray-900">{shown.map((model) => model.name).join(", ")}</p> : null}
            </div>
          )}
        >
          Pick one of these in the model picker under the message box:
        </SetupStep>
      </ol>
      <p className="text-[12px] leading-4 text-gray-500">Claude Desktop shows only Claude models. Use Claude Code, Cursor or Codex for your other models.</p>
      <DocsLink href={CLAUDE_DESKTOP_DOCS_URL} />
    </div>
  );
}

/** Any other tool: the key and both base URLs, with each model's id. */
export function OtherToolSteps({ apiKey, baseUrl }: { apiKey: string | null; baseUrl: string }) {
  const models = useGatewayToolModels(true);
  const list = models.data ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid="gateway-tool-other">
      <ol className="flex flex-col gap-4">
        {apiKey ? <SetupStep number={1} field={<KeyField apiKey={apiKey} />}>Use this key as the API key (<Strong>Authorization: Bearer</Strong> or <Strong>x-api-key</Strong>).</SetupStep> : null}
        <SetupStep number={apiKey ? 2 : 1} field={<CopyField value={baseUrl} label="Copy OpenAI base URL" testId="gateway-api-keys-base-url-openai" />}>OpenAI compatible tools take this base URL:</SetupStep>
        <SetupStep number={apiKey ? 3 : 2} field={<CopyField value={baseUrl.replace(/\/v1\/?$/, "")} label="Copy Anthropic base URL" testId="gateway-api-keys-base-url-anthropic" />}>Anthropic compatible tools take this one:</SetupStep>
        <SetupStep
          number={apiKey ? 4 : 3}
          field={(
            <div className="flex flex-col gap-2">
              <ModelsState loading={models.isLoading} error={models.error} empty={models.data && list.length === 0 ? "Your organization hasn't given you any models yet." : null} />
              <ModelSnippet models={list} loading={false} error={null} empty="">
                {(model) => model ? <CopyField value={model.alias} label={`Copy the model id for ${model.name}`} testId="gateway-tool-model-id" /> : null}
              </ModelSnippet>
            </div>
          )}
        >
          Choose a model and use its id as the model:
        </SetupStep>
      </ol>
      <DocsLink href={GATEWAY_API_KEYS_DOCS_URL} />
    </div>
  );
}

export function GatewayToolSteps({ tool, apiKey, baseUrl }: { tool: GatewayToolId; apiKey: string | null; baseUrl: string }) {
  switch (tool) {
    case "cursor": return <CursorSteps apiKey={apiKey} baseUrl={baseUrl} />;
    case "codex": return <CodexSteps apiKey={apiKey} baseUrl={baseUrl} />;
    case "codex-app": return <CodexAppSteps apiKey={apiKey} baseUrl={baseUrl} />;
    case "claude-code": return <ClaudeCodeSteps apiKey={apiKey} baseUrl={baseUrl} />;
    case "claude-desktop": return <ClaudeDesktopSteps apiKey={apiKey} baseUrl={baseUrl} />;
    case "other": return <OtherToolSteps apiKey={apiKey} baseUrl={baseUrl} />;
  }
}

export function gatewayToolName(tool: GatewayToolId) {
  return GATEWAY_TOOLS.find((entry) => entry.id === tool)?.name ?? "your tool";
}
