import { For, Show } from "solid-js";

import { useExtensions } from "../extensions/provider";

import Button from "../components/button";
import TextInput from "../components/text-input";
import { Cpu } from "lucide-solid";
import { t } from "../../i18n";

export type PluginsViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
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
};

export default function PluginsView(props: PluginsViewProps) {
  const extensions = useExtensions();
  return (
    <section class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div class="space-y-1">
            <div class="text-sm font-medium text-gray-12">{t("plugins.title")}</div>
            <div class="text-xs text-gray-10">{t("plugins.desc")}</div>
          </div>
          <div class="flex items-center gap-2">
            <button
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                extensions.pluginScope() === "project"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              }`}
              onClick={() => {
                extensions.setPluginScope("project");
                void extensions.refreshPlugins("project");
              }}
            >
              {t("plugins.scope_project")}
            </button>
            <button
              disabled={!props.canUseGlobalScope}
              class={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                extensions.pluginScope() === "global"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              } ${!props.canUseGlobalScope ? "opacity-40 cursor-not-allowed hover:text-gray-10" : ""}`}
              onClick={() => {
                if (!props.canUseGlobalScope) return;
                extensions.setPluginScope("global");
                void extensions.refreshPlugins("global");
              }}
            >
              {t("plugins.scope_global")}
            </button>
            <Button variant="ghost" onClick={() => void extensions.refreshPlugins()}>
              {t("common.refresh")}
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs text-gray-10">
          <div>{t("plugins.config_label")}</div>
          <div class="text-gray-7 font-mono truncate">{extensions.pluginConfigPath() ?? extensions.pluginConfig()?.path ?? t("plugins.not_loaded_yet")}</div>
          <Show when={props.accessHint}>
            <div class="text-gray-9">{props.accessHint}</div>
          </Show>
        </div>

        <div class="space-y-3">
          <div class="text-xs font-medium text-gray-11 uppercase tracking-wider">{t("plugins.suggested_heading")}</div>
          <div class="grid gap-3">
            <For each={props.suggestedPlugins}>
              {(plugin) => {
                const isGuided = () => plugin.installMode === "guided";
                const isInstalled = () => extensions.isPluginInstalledByName(plugin.packageName, plugin.aliases ?? []);
                const isGuideOpen = () => extensions.activePluginGuide() === plugin.packageName;

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
                            onClick={() => extensions.setActivePluginGuide(isGuideOpen() ? null : plugin.packageName)}
                          >
                            {isGuideOpen() ? t("plugins.hide_setup") : t("plugins.setup")}
                          </Button>
                        </Show>
                        <Button
                          variant={isInstalled() ? "outline" : "secondary"}
                          onClick={() => extensions.addPlugin(plugin.packageName)}
                          disabled={
                            props.busy ||
                            isInstalled() ||
                            !props.canEditPlugins ||
                            (extensions.pluginScope() === "project" && !props.selectedWorkspaceRoot.trim())
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
          when={extensions.pluginList().length}
          fallback={
            <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
              {t("plugins.empty")}
            </div>
          }
        >
          <div class="grid gap-2">
            <For each={extensions.pluginList()}>
              {(pluginName) => (
                <div class="flex items-center justify-between rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-2.5">
                  <div class="text-sm text-gray-12 font-mono">{pluginName}</div>
                  <div class="flex items-center gap-2">
                    <div class="text-[10px] uppercase tracking-wide text-gray-10">{t("plugins.enabled")}</div>
                    <Button
                      variant="ghost"
                      class="h-7 px-2 text-[11px] text-red-11 hover:text-red-12"
                      onClick={() => extensions.removePlugin(pluginName)}
                      disabled={props.busy || !props.canEditPlugins}
                    >
                      {t("plugins.remove")}
                    </Button>
                  </div>
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
                placeholder="opencode-wakatime"
                value={extensions.pluginInput()}
                onInput={(e) => extensions.setPluginInput(e.currentTarget.value)}
                hint={t("plugins.add_hint")}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => extensions.addPlugin()}
              disabled={props.busy || !extensions.pluginInput().trim() || !props.canEditPlugins}
              class="md:mt-6"
            >
              {t("plugins.add")}
            </Button>
          </div>
          <Show when={extensions.pluginStatus()}>
            <div class="text-xs text-gray-10">{extensions.pluginStatus()}</div>
          </Show>
        </div>
      </div>
    </section>
  );
}
