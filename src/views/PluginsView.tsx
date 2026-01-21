import { For, Show } from "solid-js";

import type { PluginScope } from "../app/types";
import { isTauriRuntime } from "../app/utils";
import { useI18n } from "../i18n";

import Button from "../components/Button";
import TextInput from "../components/TextInput";
import { Cpu } from "lucide-solid";

export type PluginsViewProps = {
  busy: boolean;
  activeWorkspaceRoot: string;
  pluginScope: PluginScope;
  setPluginScope: (scope: PluginScope) => void;
  pluginConfigPath: string | null;
  pluginList: string[];
  pluginInput: string;
  setPluginInput: (value: string) => void;
  pluginStatus: string | null;
  activePluginGuide: string | null;
  setActivePluginGuide: (value: string | null) => void;
  isPluginInstalled: (name: string, aliases?: string[]) => boolean;
  suggestedPlugins: Array<{
    name: string;
    packageName: string;
    description: string;
    tags: string[];
    aliases?: string[];
    installMode?: "simple" | "guided";
    steps?: Array<{
      title: string;
      description: string;
      command?: string;
      url?: string;
      path?: string;
      note?: string;
    }>;
  }>;
  refreshPlugins: (scopeOverride?: PluginScope) => void;
  addPlugin: (pluginNameOverride?: string) => void;
};

export default function PluginsView(props: PluginsViewProps) {
  const [t] = useI18n();
  return (
    <section class="space-y-6">
      <div class="bg-zinc-900/30 border border-zinc-800/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="text-sm font-medium text-white">{t("plugins.title")}</div>
            <div class="text-xs text-zinc-500">{t("plugins.desc")}</div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${props.pluginScope === "project"
                  ? "bg-white/10 text-white border-white/20"
                  : "text-zinc-500 border-zinc-800 hover:text-white"
                }`}
              onClick={() => {
                props.setPluginScope("project");
                props.refreshPlugins("project");
              }}
            >
              {t("plugins.scope.project")}
            </button>
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${props.pluginScope === "global"
                  ? "bg-white/10 text-white border-white/20"
                  : "text-zinc-500 border-zinc-800 hover:text-white"
                }`}
              onClick={() => {
                props.setPluginScope("global");
                props.refreshPlugins("global");
              }}
            >
              {t("plugins.scope.global")}
            </button>
            <Button variant="ghost" onClick={() => props.refreshPlugins()}>
              {t("plugins.scope.refresh")}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs text-zinc-500">
          <div>{t("plugins.config")}</div>
          <div class="text-zinc-600 font-mono truncate">{props.pluginConfigPath ?? t("plugins.not_loaded")}</div>
        </div>

        <div class="space-y-3">
          <div class="text-xs font-medium text-zinc-400 uppercase tracking-wider">{t("plugins.suggested")}</div>
          <div class="grid gap-3">
            <For each={props.suggestedPlugins}>
              {(plugin) => {
                const isGuided = () => plugin.installMode === "guided";
                const isInstalled = () => props.isPluginInstalled(plugin.packageName, plugin.aliases ?? []);
                const isGuideOpen = () => props.activePluginGuide === plugin.packageName;

                return (
                  <div class="rounded-2xl border border-zinc-800/60 bg-zinc-950/40 p-4 space-y-3">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-white font-mono">{plugin.name}</div>
                        <div class="text-xs text-zinc-500 mt-1">{plugin.description}</div>
                        <Show when={plugin.packageName !== plugin.name}>
                          <div class="text-xs text-zinc-600 font-mono mt-1">{plugin.packageName}</div>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={isGuided()}>
                          <Button
                            variant="ghost"
                            onClick={() => props.setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)}
                          >
                            {isGuideOpen() ? t("plugins.actions.hide_setup") : t("plugins.actions.setup")}
                          </Button>
                        </Show>
                        <Button
                          variant={isInstalled() ? "outline" : "secondary"}
                          onClick={() => props.addPlugin(plugin.packageName)}
                          disabled={
                            props.busy ||
                            isInstalled() ||
                            !isTauriRuntime() ||
                            (props.pluginScope === "project" && !props.activeWorkspaceRoot.trim())
                          }
                        >
                          {isInstalled() ? t("plugins.actions.added") : t("plugins.actions.add")}
                        </Button>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <For each={plugin.tags}>
                        {(tag) => (
                          <span class="text-[10px] uppercase tracking-wide bg-zinc-800/70 text-zinc-400 px-2 py-0.5 rounded-full">
                            {tag}
                          </span>
                        )}
                      </For>
                    </div>
                    <Show when={isGuided() && isGuideOpen()}>
                      <div class="rounded-xl border border-zinc-800/70 bg-zinc-950/60 p-4 space-y-3">
                        <For each={plugin.steps ?? []}>
                          {(step, idx) => (
                            <div class="space-y-1">
                              <div class="text-xs font-medium text-zinc-300">
                                {idx() + 1}. {step.title}
                              </div>
                              <div class="text-xs text-zinc-500">{step.description}</div>
                              <Show when={step.command}>
                                <div class="text-xs font-mono text-zinc-200 bg-zinc-900/60 border border-zinc-800/70 rounded-lg px-3 py-2">
                                  {step.command}
                                </div>
                              </Show>
                              <Show when={step.note}>
                                <div class="text-xs text-zinc-500">{step.note}</div>
                              </Show>
                              <Show when={step.url}>
                                <div class="text-xs text-zinc-500">
                                  {t("plugins.steps.open")} <span class="font-mono text-zinc-400">{step.url}</span>
                                </div>
                              </Show>
                              <Show when={step.path}>
                                <div class="text-xs text-zinc-500">
                                  {t("plugins.steps.path")} <span class="font-mono text-zinc-400">{step.path}</span>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </div>

        <Show
          when={props.pluginList.length}
          fallback={
            <div class="rounded-xl border border-zinc-800/60 bg-zinc-950/40 p-4 text-sm text-zinc-500">
              {t("plugins.empty")}
            </div>
          }
        >
          <div class="grid gap-2">
            <For each={props.pluginList}>
              {(pluginName) => (
                <div class="flex items-center justify-between rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-2.5">
                  <div class="text-sm text-zinc-200 font-mono">{pluginName}</div>
                  <div class="text-[10px] uppercase tracking-wide text-zinc-500">{t("plugins.enabled")}</div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col md:flex-row gap-3">
            <div class="flex-1">
              <TextInput
                label={t("plugins.add.label")}
                placeholder="opencode-wakatime"
                value={props.pluginInput}
                onInput={(e) => props.setPluginInput(e.currentTarget.value)}
                hint={t("plugins.add.hint")}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => props.addPlugin()}
              disabled={props.busy || !props.pluginInput.trim()}
              class="md:mt-6"
            >
              {t("plugins.add.btn")}
            </Button>
          </div>
          <Show when={props.pluginStatus}>
            <div class="text-xs text-zinc-500">{props.pluginStatus}</div>
          </Show>
        </div>
      </div>
    </section>
  );
}
