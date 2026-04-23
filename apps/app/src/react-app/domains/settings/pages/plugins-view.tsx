/** @jsxImportSource react */
import { Cpu } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";

// Explicit, prop-driven shape of the extensions store. The Solid
// PluginsView pulled this from useExtensions(); in React we pass it
// in so the page stays stateless and the extensions provider can be
// ported separately.
export type PluginsExtensionsStore = {
  pluginScope: "project" | "global";
  setPluginScope: (value: "project" | "global") => void;
  refreshPlugins: (scope?: "project" | "global") => void | Promise<void>;
  pluginConfigPath: () => string | null;
  pluginConfig: () => { path?: string | null } | null;
  pluginList: () => string[];
  pluginInput: () => string;
  setPluginInput: (value: string) => void;
  pluginStatus: () => string | null;
  addPlugin: (packageName?: string) => void | Promise<void>;
  removePlugin: (packageName: string) => void | Promise<void>;
  isPluginInstalledByName: (packageName: string, aliases?: string[]) => boolean;
  activePluginGuide: () => string | null;
  setActivePluginGuide: (packageName: string | null) => void;
};

type SuggestedPlugin = {
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
};

export type PluginsViewProps = {
  extensions: PluginsExtensionsStore;
  busy: boolean;
  selectedWorkspaceRoot: string;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
};

export function PluginsView(props: PluginsViewProps) {
  const { extensions } = props;
  const scope = extensions.pluginScope;
  return (
    <section className="space-y-6">
      <div className="bg-gray-2/30 border border-gray-6/50 rounded-2xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="text-sm font-medium text-gray-12">
              {t("plugins.title")}
            </div>
            <div className="text-xs text-gray-10">{t("plugins.desc")}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                scope === "project"
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
              type="button"
              disabled={!props.canUseGlobalScope}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                scope === "global"
                  ? "bg-gray-12/10 text-gray-12 border-gray-6/20"
                  : "text-gray-10 border-gray-6 hover:text-gray-12"
              } ${
                !props.canUseGlobalScope
                  ? "opacity-40 cursor-not-allowed hover:text-gray-10"
                  : ""
              }`}
              onClick={() => {
                if (!props.canUseGlobalScope) return;
                extensions.setPluginScope("global");
                void extensions.refreshPlugins("global");
              }}
            >
              {t("plugins.scope_global")}
            </button>
            <Button
              variant="ghost"
              onClick={() => void extensions.refreshPlugins()}
            >
              {t("common.refresh")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1 text-xs text-gray-10">
          <div>{t("plugins.config_label")}</div>
          <div className="text-gray-7 font-mono truncate">
            {extensions.pluginConfigPath() ??
              extensions.pluginConfig()?.path ??
              t("plugins.not_loaded_yet")}
          </div>
          {props.accessHint ? (
            <div className="text-gray-9">{props.accessHint}</div>
          ) : null}
        </div>

        <div className="space-y-3">
          <div className="text-xs font-medium text-gray-11 uppercase tracking-wider">
            {t("plugins.suggested_heading")}
          </div>
          <div className="grid gap-3">
            {props.suggestedPlugins.map((plugin) => {
              const isGuided = plugin.installMode === "guided";
              const isInstalled = extensions.isPluginInstalledByName(
                plugin.packageName,
                plugin.aliases ?? [],
              );
              const isGuideOpen =
                extensions.activePluginGuide() === plugin.packageName;

              return (
                <div
                  key={plugin.packageName}
                  className="rounded-2xl border border-gray-6/60 bg-gray-1/40 p-4 space-y-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-gray-12 font-mono">
                        {plugin.name}
                      </div>
                      <div className="text-xs text-gray-10 mt-1">
                        {plugin.description}
                      </div>
                      {plugin.packageName !== plugin.name ? (
                        <div className="text-xs text-gray-7 font-mono mt-1">
                          {plugin.packageName}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-2">
                      {isGuided ? (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            extensions.setActivePluginGuide(
                              isGuideOpen ? null : plugin.packageName,
                            )
                          }
                        >
                          {isGuideOpen
                            ? t("plugins.hide_setup")
                            : t("plugins.setup")}
                        </Button>
                      ) : null}
                      <Button
                        variant={isInstalled ? "outline" : "secondary"}
                        onClick={() => extensions.addPlugin(plugin.packageName)}
                        disabled={
                          props.busy ||
                          isInstalled ||
                          !props.canEditPlugins ||
                          (scope === "project" &&
                            !props.selectedWorkspaceRoot.trim())
                        }
                      >
                        {isInstalled ? t("plugins.added") : t("plugins.add")}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {plugin.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] uppercase tracking-wide bg-gray-4/70 text-gray-11 px-2 py-0.5 rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  {isGuided && isGuideOpen ? (
                    <div className="rounded-xl border border-gray-6/70 bg-gray-1/60 p-4 space-y-3">
                      {(plugin.steps ?? []).map((step, idx) => (
                        <div key={`${plugin.packageName}-step-${idx}`} className="space-y-1">
                          <div className="text-xs font-medium text-gray-11">
                            {idx + 1}. {step.title}
                          </div>
                          <div className="text-xs text-gray-10">
                            {step.description}
                          </div>
                          {step.command ? (
                            <div className="text-xs font-mono text-gray-12 bg-gray-2/60 border border-gray-6/70 rounded-lg px-3 py-2">
                              {step.command}
                            </div>
                          ) : null}
                          {step.note ? (
                            <div className="text-xs text-gray-10">
                              {step.note}
                            </div>
                          ) : null}
                          {step.url ? (
                            <div className="text-xs text-gray-10">
                              Open:{" "}
                              <span className="font-mono text-gray-11">
                                {step.url}
                              </span>
                            </div>
                          ) : null}
                          {step.path ? (
                            <div className="text-xs text-gray-10">
                              Path:{" "}
                              <span className="font-mono text-gray-11">
                                {step.path}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {extensions.pluginList().length === 0 ? (
          <div className="rounded-xl border border-gray-6/60 bg-gray-1/40 p-4 text-sm text-gray-10">
            {t("plugins.empty")}
          </div>
        ) : (
          <div className="grid gap-2">
            {extensions.pluginList().map((pluginName) => (
              <div
                key={pluginName}
                className="flex items-center justify-between rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-2.5"
              >
                <div className="text-sm text-gray-12 font-mono flex items-center gap-2">
                  <Cpu size={14} className="text-gray-10" />
                  {pluginName}
                </div>
                <div className="flex items-center gap-2">
                  <div className="text-[10px] uppercase tracking-wide text-gray-10">
                    {t("plugins.enabled")}
                  </div>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-red-11 hover:text-red-12"
                    onClick={() => extensions.removePlugin(pluginName)}
                    disabled={props.busy || !props.canEditPlugins}
                  >
                    {t("plugins.remove")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col md:flex-row gap-3">
            <div className="flex-1">
              <TextInput
                label={t("plugins.add_label")}
                placeholder="opencode-wakatime"
                value={extensions.pluginInput()}
                onChange={(event) =>
                  extensions.setPluginInput(event.currentTarget.value)
                }
                hint={t("plugins.add_hint")}
              />
            </div>
            <Button
              variant="secondary"
              onClick={() => extensions.addPlugin()}
              disabled={
                props.busy ||
                !extensions.pluginInput().trim() ||
                !props.canEditPlugins
              }
              className="md:mt-6"
            >
              {t("plugins.add")}
            </Button>
          </div>
          {extensions.pluginStatus() ? (
            <div className="text-xs text-gray-10">
              {extensions.pluginStatus()}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
