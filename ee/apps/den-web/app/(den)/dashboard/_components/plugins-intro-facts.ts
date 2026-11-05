"use client";

import { useFeatureIntro, useFeatureIntroRuntime, type FeatureIntroKey } from "../_features/feature-intros";
import type { PluginsFacts } from "../_features/feature-intros/intros/plugins";
import type { AccessDraft } from "./access-summary";
import type { ConnectedIntegration } from "./integration-data";
import type { DenPlugin } from "./plugin-data";

/** Who made the organization's plugins, when that was one other person and none was the viewer. */
export function pluginsSetUpById(
  plugins: ReadonlyArray<{ createdByOrgMembershipId: string | null }>,
  viewerId: string | null,
): string | null {
  if (plugins.some((plugin) => plugin.createdByOrgMembershipId !== null && plugin.createdByOrgMembershipId === viewerId)) return null;
  const ids = new Set(plugins.flatMap((plugin) => (plugin.createdByOrgMembershipId ? [plugin.createdByOrgMembershipId] : [])));
  return ids.size === 1 ? [...ids][0] : null;
}

/** Whether anyone besides its owner can use a plugin: everyone, a team, or another person. */
export function pluginSharedBeyondOwner(draft: AccessDraft, ownerId: string | null): boolean {
  return draft.orgWide || draft.teamIds.length > 0 || draft.memberIds.some((id) => id !== ownerId);
}

/** Plugin Directory facts (DESIGN.md I2) from the plugin list and connected sources it already loads. */
export function pluginDirectoryIntroFacts(
  plugins: readonly DenPlugin[],
  connections: readonly ConnectedIntegration[],
): PluginsFacts {
  // Built-in OpenWork extensions every org gets don't count as the team setting up plugins.
  const teamPlugins = plugins.filter((plugin) => !plugin.builtIn);
  const count = (pick: (plugin: DenPlugin) => readonly unknown[]) => plugins.reduce((total, plugin) => total + pick(plugin).length, 0);
  return {
    plugins: teamPlugins.length,
    agents: count((plugin) => plugin.agents),
    commands: count((plugin) => plugin.commands),
    hooks: count((plugin) => plugin.hooks),
    mcps: count((plugin) => plugin.mcps),
    githubSources: connections.filter((connection) => connection.provider === "github").length,
  };
}

/**
 * Registers a setup-step intro (create, import, skill editor) so `?` can
 * explain the form (DESIGN.md I8). It never shows on its own and renders
 * nothing; with the flag off it does nothing.
 */
export function PluginsSetupIntro({ introKey }: { introKey: Extract<FeatureIntroKey, "plugins.new" | "plugins.import" | "plugins.skill"> }) {
  const enabled = useFeatureIntroRuntime().enabled;
  useFeatureIntro(introKey, enabled ? {} : null);
  return null;
}
