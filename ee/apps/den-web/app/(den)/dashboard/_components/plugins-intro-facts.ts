"use client";

import { useQueries } from "@tanstack/react-query";
import { useFeatureIntro, useFeatureIntroRuntime, type FeatureIntroKey } from "../_features/feature-intros";
import type { PluginsFacts } from "../_features/feature-intros/intros/plugins";
import type { AccessDraft } from "./access-summary";
import type { ConnectedIntegration } from "./integration-data";
import { type MarketplaceAccessGrant, marketplaceAccessQueryOptions } from "./marketplace-data";
import type { DenPlugin } from "./plugin-data";
import { visibleCountFact } from "../_features/feature-intros/model";

export function pluginsSetUpById(
  plugins: ReadonlyArray<{ createdByOrgMembershipId: string | null }>,
  viewerId: string | null,
): string | null {
  if (plugins.some((plugin) => plugin.createdByOrgMembershipId !== null && plugin.createdByOrgMembershipId === viewerId)) return null;
  const ids = new Set(plugins.flatMap((plugin) => (plugin.createdByOrgMembershipId ? [plugin.createdByOrgMembershipId] : [])));
  return ids.size === 1 ? [...ids][0] : null;
}

export function pluginSharedBeyondOwner(draft: AccessDraft, ownerId: string | null): boolean {
  return draft.orgWide || draft.teamIds.length > 0 || draft.memberIds.some((id) => id !== ownerId);
}

export function pluginSharedBeyondOwnerWithCollections(
  draft: AccessDraft,
  ownerId: string | null,
  collectionGrants: ReadonlyArray<readonly MarketplaceAccessGrant[] | null>,
): boolean | null {
  if (pluginSharedBeyondOwner(draft, ownerId)) return true;
  const shared = collectionGrants.some((grants) => grants?.some((grant) => grant.orgWide || grant.teamId !== null || (grant.orgMembershipId !== null && grant.orgMembershipId !== ownerId)));
  if (shared) return true;
  return collectionGrants.some((grants) => grants === null) ? null : false;
}

export function usePluginCollectionGrants(
  collectionIds: readonly string[],
  enabled: boolean,
): Array<readonly MarketplaceAccessGrant[] | null> | undefined {
  const results = useQueries({
    queries: collectionIds.map((id) => ({ ...marketplaceAccessQueryOptions(id), enabled, retry: false })),
  });
  if (!enabled) return undefined;
  if (results.some((result) => result.isPending && !result.isError)) return undefined;
  return results.map((result) => result.data ?? null);
}

export function pluginDirectoryIntroFacts(
  plugins: readonly DenPlugin[],
  connections: readonly ConnectedIntegration[],
  seesAllPlugins: boolean,
): PluginsFacts {
  const teamPlugins = plugins.filter((plugin) => !plugin.builtIn);
  const count = (pick: (plugin: DenPlugin) => readonly unknown[]) =>
    visibleCountFact(plugins.reduce((total, plugin) => total + pick(plugin).length, 0), seesAllPlugins);
  return {
    plugins: visibleCountFact(teamPlugins.length, seesAllPlugins),
    agents: count((plugin) => plugin.agents),
    commands: count((plugin) => plugin.commands),
    hooks: count((plugin) => plugin.hooks),
    mcps: count((plugin) => plugin.mcps),
    githubSources: connections.filter((connection) => connection.provider === "github").length,
  };
}

export function PluginsSetupIntro({ introKey }: { introKey: Extract<FeatureIntroKey, "plugins.new" | "plugins.import" | "plugins.skill"> }) {
  const enabled = useFeatureIntroRuntime().enabled;
  useFeatureIntro(introKey, enabled ? {} : null);
  return null;
}
