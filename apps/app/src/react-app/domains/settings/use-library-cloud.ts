import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DenClient } from "../../../app/lib/den";
import type {
  DenLibraryAccessGrant,
  DenLibraryItem,
  DenLibraryOrgDirectory,
  DenLibraryPluginItem,
} from "../../../app/lib/den-library";
import { isOwnedLibraryPlugin, libraryAudienceFromGrants, type LibraryAudience } from "./library-sharing";
import { parseSkillMarkdown, skillMarkdown } from "./library";

export type LibraryShareTarget = { kind: "team"; id: string } | { kind: "person"; id: string } | { kind: "everyone" };

export type LibraryCloud = {
  ready: boolean;
  items: DenLibraryItem[];
  directory: DenLibraryOrgDirectory | null;
  pluginById: Map<string, DenLibraryPluginItem>;
  ownedPluginIds: Set<string>;
  audienceFor: (pluginId: string) => LibraryAudience;
  grantsFor: (pluginId: string) => DenLibraryAccessGrant[];
  refresh: () => Promise<void>;
  /** Makes the audience exactly `targets`: grants what is missing and revokes the rest. */
  setAudience: (pluginId: string, targets: LibraryShareTarget[]) => Promise<void>;
  archive: (pluginId: string) => Promise<void>;
  restore: (pluginId: string) => Promise<void>;
  readSkill: (pluginId: string) => Promise<LibraryEditableSkill | null>;
  saveSkill: (skill: LibraryEditableSkill, next: { name: string; description: string; instructions: string }) => Promise<void>;
};

export type LibraryEditableSkill = {
  pluginId: string;
  configObjectId: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  rawSourceText: string;
};

function grantMatches(grant: DenLibraryAccessGrant, target: LibraryShareTarget) {
  if (target.kind === "everyone") return grant.orgWide;
  if (target.kind === "team") return grant.teamId === target.id;
  return grant.orgMembershipId === target.id;
}

export function useLibraryCloud(input: {
  client: DenClient;
  baseUrl: string;
  organizationId: string;
  enabled: boolean;
}): LibraryCloud {
  const queryClient = useQueryClient();
  const scope: [string, string] = [input.baseUrl, input.organizationId];
  const itemsQuery = useQuery({
    queryKey: ["library-cloud-items", ...scope],
    enabled: input.enabled,
    queryFn: () => input.client.listMeLibraryItems(input.organizationId),
  });
  const directoryQuery = useQuery({
    queryKey: ["library-cloud-directory", ...scope],
    enabled: input.enabled,
    queryFn: () => input.client.getLibraryOrgDirectory(input.organizationId),
  });
  const accessQuery = useQuery({
    queryKey: ["library-cloud-access", ...scope],
    enabled: input.enabled,
    queryFn: () => input.client.listManagedPluginAccess(input.organizationId),
  });
  const items = input.enabled ? itemsQuery.data ?? [] : [];
  const plugins = items.filter((item): item is DenLibraryPluginItem => item.type === "plugin");
  const owned = plugins.filter(isOwnedLibraryPlugin);
  const listedAccess = accessQuery.data;
  const unlisted = listedAccess ? owned.filter((plugin) => !listedAccess.has(plugin.id)) : accessQuery.isError ? owned : [];
  const grantQueries = useQueries({
    queries: unlisted.map((plugin) => ({
      queryKey: ["library-cloud-grants", ...scope, plugin.id],
      enabled: input.enabled,
      queryFn: () => input.client.listPluginAccess(input.organizationId, plugin.id),
    })),
  });
  const unlistedGrants = new Map(unlisted.map((plugin, index) => [plugin.id, grantQueries[index]?.data ?? []]));
  const grantsById = new Map(owned.map((plugin) => [plugin.id, listedAccess?.get(plugin.id) ?? unlistedGrants.get(plugin.id) ?? []]));
  const directory = input.enabled ? directoryQuery.data ?? null : null;

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["library-cloud-items", ...scope] }),
      queryClient.invalidateQueries({ queryKey: ["library-cloud-access", ...scope] }),
      queryClient.invalidateQueries({ queryKey: ["library-cloud-grants", ...scope] }),
    ]);
  };

  return {
    ready: input.enabled && itemsQuery.isSuccess,
    items,
    directory,
    pluginById: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    ownedPluginIds: new Set(owned.map((plugin) => plugin.id)),
    audienceFor: (pluginId) => libraryAudienceFromGrants(grantsById.get(pluginId) ?? [], directory),
    grantsFor: (pluginId) => grantsById.get(pluginId) ?? [],
    refresh,
    setAudience: async (pluginId, targets) => {
      const grants = await input.client.listPluginAccess(input.organizationId, pluginId);
      const ownerId = directory?.currentMemberId ?? null;
      const shareGrants = grants.filter((grant) => grant.orgMembershipId === null || grant.orgMembershipId !== ownerId);
      for (const target of targets) {
        if (shareGrants.some((grant) => grantMatches(grant, target))) continue;
        await input.client.grantPluginAccess(
          input.organizationId,
          pluginId,
          target.kind === "everyone" ? { orgWide: true } : target.kind === "team" ? { teamId: target.id } : { orgMembershipId: target.id },
        );
      }
      for (const grant of shareGrants) {
        if (grant.role === "owner" || grant.role === "manager") continue;
        if (targets.some((target) => grantMatches(grant, target))) continue;
        await input.client.revokePluginAccess(input.organizationId, pluginId, grant.id);
      }
      const saved = await input.client.listPluginAccess(input.organizationId, pluginId);
      queryClient.setQueryData(["library-cloud-grants", ...scope, pluginId], saved);
      queryClient.setQueryData<Map<string, DenLibraryAccessGrant[]>>(
        ["library-cloud-access", ...scope],
        (current) => current && new Map(current).set(pluginId, saved),
      );
      await refresh();
    },
    archive: async (pluginId) => {
      await input.client.archivePlugin(input.organizationId, pluginId);
      queryClient.setQueryData<DenLibraryItem[]>(
        ["library-cloud-items", ...scope],
        (current) => current?.filter((item) => item.id !== pluginId),
      );
      await refresh();
    },
    restore: async (pluginId) => {
      await input.client.restorePlugin(input.organizationId, pluginId);
      await refresh();
    },
    readSkill: async (pluginId) => {
      const files = await input.client.listPluginFiles(input.organizationId, pluginId);
      const file = files.find((entry) => entry.objectType.toLowerCase() === "skill");
      if (!file) return null;
      const raw = file.rawSourceText
        ?? (await input.client.getLatestConfigObjectVersion(input.organizationId, file.configObjectId))?.rawSourceText
        ?? "";
      const parsed = parseSkillMarkdown(raw);
      const plugin = plugins.find((entry) => entry.id === pluginId);
      return {
        pluginId,
        configObjectId: file.configObjectId,
        slug: parsed.name || file.title,
        name: plugin?.name ?? file.title,
        description: parsed.description,
        instructions: parsed.body,
        rawSourceText: raw,
      };
    },
    saveSkill: async (skill, next) => {
      const description = next.description.trim();
      await input.client.createConfigObjectVersion(input.organizationId, skill.configObjectId, {
        rawSourceText: skillMarkdown(skill.slug, description || next.name.trim(), next.instructions.trim()),
        metadata: { name: skill.slug, ...(description ? { description } : {}) },
      });
      await refresh();
    },
  };
}