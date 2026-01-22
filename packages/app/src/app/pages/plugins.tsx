import { For, Show } from "solid-js";

import type { PluginScope } from "../types";
import { isTauriRuntime } from "../utils";
import { t } from "../../i18n";

import Button from "../components/button";
import TextInput from "../components/text-input";
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
  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="text-sm font-medium text-gray-12">{t("plugins.title")}</div>
            <div class="text-xs text-gray-10">{t("plugins.description")}</div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                props.pluginScope === "project"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              }`}
              onClick={() => {
                props.setPluginScope("project");
                props.refreshPlugins("project");
              }}
            >
              {t("plugins.scope_project")}
            </button>
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                props.pluginScope === "global"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              }`}
              onClick={() => {
                props.setPluginScope("global");
                props.refreshPlugins("global");
              }}
            >
              {t("plugins.scope_global")}
            </button>
            <Button variant="ghost" onClick={() => props.refreshPlugins()}>
              {t("plugins.refresh")}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs text-gray-10">
          <div>{t("plugins.config")}</div>
          <div class="text-gray-7 font-mono truncate">{props.pluginConfigPath ?? t("plugins.not_loaded")}</div>
        </div>

        <div class="space-y-3">
          <div class="text-xs font-medium text-gray-11 uppercase tracking-wider">{t("plugins.suggested")}</div>
          <div class="grid gap-3">
            <For each={props.suggestedPlugins}>
              {(plugin) => {
                const isGuided = () => plugin.installMode === "guided";
                const isInstalled = () => props.isPluginInstalled(plugin.packageName, plugin.aliases ?? []);
                const isGuideOpen = () => props.activePluginGuide === plugin.packageName;

                return (
                  <div class="rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3">
                    <div class="flex items-start justify-between gap-4">
                      <div>
                        <div class="text-sm font-medium text-gray-12 font-mono">{plugin.name}</div>
                        <div class="text-xs text-gray-10 mt-1">{plugin.description}</div>
                        <Show when={plugin.packageName !== plugin.name}>
                          <div class="text-xs text-gray-7 font-mono mt-1">{plugin.packageName}</div>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2">
                        <Show when={isGuided()}>
                          <Button
                            variant="ghost"
                            onClick={() => props.setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)}
                          >
                            {isGuideOpen() ? t("plugins.hide_setup") : t("plugins.setup")}
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
                          {isInstalled() ? t("plugins.added") : t("plugins.add")}
                        </Button>
                      </div>
                    </div>
                    <div class="flex flex-wrap gap-2">
                      <For each={plugin.tags}>
                        {(tag) => (
                          <span class="text-[10px] uppercase tracking-wide bg-gray-4/70 text-gray-11 px-2 py-0.5 rounded-full">
                            {tag}
                          </span>
                        )}
                      </For>
                    </div>
                    <Show when={isGuided() && isGuideOpen()}>
                      <div class="rounded-xl border border-gray-6/70 bg-gray-1/60 p-4 space-y-3">
                        <For each={plugin.steps ?? []}>
                          {(step, idx) => (
                            <div class="space-y-1">
                              <div class="text-xs font-medium text-gray-11">
                                {idx() + 1}. {step.title}
                              </div>
                              <div class="text-xs text-gray-10">{step.description}</div>
                              <Show when={step.command}>
                                <div class="text-xs font-mono text-gray-12 bg-gray-2/60 border border-gray-6/70 rounded-lg px-3 py-2">
                                  {step.command}
                                </div>
                              </Show>
                              <Show when={step.note}>
                                <div class="text-xs text-gray-10">{step.note}</div>
                              </Show>
                              <Show when={step.url}>
                                <div class="text-xs text-gray-10">
                                  Open: <span class="font-mono text-gray-11">{step.url}</span>
                                </div>
                              </Show>
                              <Show when={step.path}>
                                <div class="text-xs text-gray-10">
                                  Path: <span class="font-mono text-gray-11">{step.path}</span>
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
            <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
              {t("plugins.no_plugins")}
            </div>
          }
        >
          <div class="grid gap-2">
            <For each={props.pluginList}>
              {(pluginName) => (
                <div class="flex items-center justify-between rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-2.5">
                  <div class="text-sm text-gray-12 font-mono">{pluginName}</div>
                  <div class="text-[10px] uppercase tracking-wide text-gray-10">{t("plugins.enabled")}</div>
                </div>
              )}
            </For>
          </div>
        </Show>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col md:flex-row gap-3">
            <div class="flex-1">
              <TextInput
                label={t("plugins.add_label")}
                placeholder={t("plugins.placeholder")}
                value={props.pluginInput}
                onInput={(e) => props.setPluginInput(e.currentTarget.value)}
                hint={t("plugins.add_hint")}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => props.addPlugin()}
              disabled={props.busy || !props.pluginInput.trim()}
              class="md:mt-6"
            >
              {t("plugins.add")}
            </Button>
          </div>
          <Show when={props.pluginStatus}>
            <div class="text-xs text-gray-10">{props.pluginStatus}</div>
          </Show>
        </div>
      </div>
    </section>
  );
}
