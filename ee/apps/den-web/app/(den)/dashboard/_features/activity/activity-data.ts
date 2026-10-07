import { z } from "zod";
import {
  getAiGatewayProviderRoute,
  getLlmProviderRoute,
  getMarketplaceRoute,
  getMcpConnectionRoute,
  getPluginSkillRoute,
} from "../../../_lib/den-org";

export type DashboardActivityEntry = {
  id: string;
  kind: "connection" | "skill" | "plugin" | "provider";
  title: string;
  detail: string;
  occurredAt: string;
  href: string;
  action: "Open" | "Browse";
  logo?: { name: string; url?: string; providerId?: string };
};

const labelSchema = z.string().trim().min(1);
// Old responses may not expose a stored timestamp. Never substitute updatedAt,
// connectedAt, or the current time for the event's actual creation time.
const createdAtSchema = z.string().datetime({ offset: true }).nullable().catch(null);
const cursorSchema = labelSchema.nullish();
const resourceSchema = z.object({ id: labelSchema, name: labelSchema });
const connectionSchema = resourceSchema.extend({
  createdAt: createdAtSchema,
  url: z.string().optional(),
});
const providerSchema = resourceSchema.extend({
  createdAt: createdAtSchema,
  providerId: labelSchema,
});
const pluginSchema = resourceSchema.extend({
  status: z.string(),
  deletedAt: z.string().nullable(),
});
const marketplaceSchema = resourceSchema.extend({
  status: z.string(),
  deletedAt: z.string().nullable(),
});
const membershipSchema = z.object({
  removedAt: z.string().nullable(),
  configObject: z.object({
    id: labelSchema,
    title: labelSchema,
    objectType: labelSchema,
    status: z.string(),
    deletedAt: z.string().nullable(),
    latestVersion: z.object({ id: labelSchema }).nullish(),
  }),
});
const attachmentSchema = z.object({
  id: labelSchema,
  pluginId: labelSchema,
  createdAt: createdAtSchema,
  removedAt: z.string().nullable(),
  membershipSource: z.string(),
});
const versionSchema = z.object({
  id: labelSchema,
  configObjectId: labelSchema,
  createdAt: createdAtSchema,
  isDeletedVersion: z.boolean(),
});

function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: cursorSchema });
}

const connectionsSchema = z.object({ connections: z.array(connectionSchema), nextCursor: cursorSchema });
const providersSchema = z.object({ llmProviders: z.array(providerSchema), nextCursor: cursorSchema });
const gatewayProvidersSchema = z.object({ inferenceProviders: z.array(providerSchema), nextCursor: cursorSchema });

export type ActivityRequest = (path: string, signal: AbortSignal) => Promise<unknown>;
export type ActivityVersions = z.infer<typeof versionSchema>[];

export type DashboardActivityInput = {
  orgSlug: string | null;
  gatewayEnabled: boolean;
  signal: AbortSignal;
  request: ActivityRequest;
  versionCache?: {
    get: (skillId: string, latestVersionId: string) => ActivityVersions | undefined;
    set: (skillId: string, latestVersionId: string, versions: ActivityVersions) => void;
  };
};

const FETCH_CONCURRENCY = 5;
const ACTIVITY_LIMIT = 5;

/** Follow every discovery page, failing rather than silently accepting a loop. */
async function readPages<T>(
  input: DashboardActivityInput,
  path: string,
  parse: (payload: unknown) => { items: T[]; nextCursor?: string | null },
  limit = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const items: T[] = [];
  const cursors = new Set<string>();
  let cursor: string | null | undefined;
  do {
    input.signal.throwIfAborted();
    const separator = path.includes("?") ? "&" : "?";
    const pagePath = cursor ? `${path}${separator}cursor=${encodeURIComponent(cursor)}` : path;
    const page = parse(await input.request(pagePath, input.signal));
    input.signal.throwIfAborted();
    items.push(...page.items.slice(0, limit - items.length));
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("Activity pagination did not advance.");
    if (cursor) cursors.add(cursor);
  } while (cursor && items.length < limit);
  return items;
}

/** Bound detail/version fanout even for organizations with many plugins. */
async function mapConcurrent<T, U>(
  items: readonly T[],
  signal: AbortSignal,
  load: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Map<number, U>();
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, async () => {
    while (!failed) {
      signal.throwIfAborted();
      const index = next++;
      const item = items[index];
      if (item === undefined) return;
      try {
        results.set(index, await load(item));
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }));
  return [...results.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
}

export function newestDashboardActivity(entries: readonly DashboardActivityEntry[]): DashboardActivityEntry[] {
  const unique = new Map<string, DashboardActivityEntry>();
  for (const entry of entries) {
    if (createdAtSchema.parse(entry.occurredAt)) unique.set(entry.id, entry);
  }
  return [...unique.values()]
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt) || left.id.localeCompare(right.id))
    .slice(0, ACTIVITY_LIMIT);
}

/**
 * A recoverable snapshot, not an audit log: only currently visible, existing
 * resources and their stored creation/version dates can contribute an entry.
 * Every required read must succeed before anything is returned to the cache.
 */
export async function fetchDashboardActivity(input: DashboardActivityInput): Promise<DashboardActivityEntry[]> {
  const { orgSlug } = input;
  const [connections, providers, gatewayProviders, plugins, marketplaces] = await Promise.all([
    // The member-facing Connect kill switch does not disable admin management.
    readPages(input, "/v1/mcp-connections?scope=manageable", (payload) => {
      const page = connectionsSchema.parse(payload);
      return { items: page.connections, nextCursor: page.nextCursor };
    }),
    readPages(input, "/v1/llm-providers?scope=manageable", (payload) => {
      const page = providersSchema.parse(payload);
      return { items: page.llmProviders, nextCursor: page.nextCursor };
    }),
    input.gatewayEnabled
      ? readPages(input, "/v1/inference-providers?scope=manageable", (payload) => {
          const page = gatewayProvidersSchema.parse(payload);
          return { items: page.inferenceProviders, nextCursor: page.nextCursor };
        })
      : Promise.resolve([]),
    readPages(input, "/v1/plugins?status=active&limit=100", (payload) => pageSchema(pluginSchema).parse(payload)),
    readPages(input, "/v1/marketplaces?status=active&limit=100", (payload) => pageSchema(marketplaceSchema).parse(payload)),
  ]);
  const entries: DashboardActivityEntry[] = [];
  for (const connection of connections) {
    if (!connection.createdAt) continue;
    entries.push({
      id: `connection:${connection.id}`,
      kind: "connection",
      title: `${connection.name} was added`,
      detail: "Connection",
      occurredAt: connection.createdAt,
      href: getMcpConnectionRoute(orgSlug, connection.id),
      action: "Open",
      logo: { name: connection.name, ...(connection.url ? { url: connection.url } : {}) },
    });
  }
  for (const [source, items] of new Map([["legacy", providers], ["gateway", gatewayProviders]])) {
    for (const provider of items) {
      if (!provider.createdAt) continue;
      entries.push({
        id: `provider:${source}:${provider.id}`,
        kind: "provider",
        title: `${provider.name} was added`,
        detail: "Model provider",
        occurredAt: provider.createdAt,
        href: source === "gateway"
          ? getAiGatewayProviderRoute(orgSlug, provider.id)
          : getLlmProviderRoute(orgSlug, provider.id),
        action: "Open",
        logo: { name: provider.name, providerId: provider.providerId },
      });
    }
  }

  const activePlugins = [...new Map(plugins.filter((plugin) => plugin.status === "active" && plugin.deletedAt === null)
    .map((plugin) => [plugin.id, plugin])).values()];
  const contents = await mapConcurrent(activePlugins, input.signal, async (plugin) => {
    const memberships = await readPages(input, `/v1/plugins/${encodeURIComponent(plugin.id)}/resolved`,
      (payload) => pageSchema(membershipSchema).parse(payload));
    const skills = [...new Map(memberships
      .filter((membership) => membership.removedAt === null)
      .map((membership) => membership.configObject)
      .filter((object) => object.objectType === "skill" && object.status === "active" && object.deletedAt === null)
      .map((skill) => [skill.id, skill])).values()];
    return { plugin, skills };
  });
  const contentsByPlugin = new Map(contents.map((content) => [content.plugin.id, content]));
  const activeMarketplaces = [...new Map(marketplaces
    .filter((marketplace) => marketplace.status === "active" && marketplace.deletedAt === null)
    .map((marketplace) => [marketplace.id, marketplace])).values()];
  const attachments = await mapConcurrent(activeMarketplaces, input.signal, async (marketplace) => ({
    marketplace,
    memberships: await readPages(input, `/v1/marketplaces/${encodeURIComponent(marketplace.id)}/plugins`,
      (payload) => pageSchema(attachmentSchema).parse(payload)),
  }));
  for (const { marketplace, memberships } of attachments) {
    for (const membership of memberships) {
      const content = contentsByPlugin.get(membership.pluginId);
      // The built-in catalog is provisioned by a read, not new workspace work.
      if (!content || membership.membershipSource === "system" || membership.removedAt !== null || !membership.createdAt) continue;
      entries.push({
        id: `plugin:${membership.id}`,
        kind: "plugin",
        title: `${content.plugin.name} was added to the ${marketplace.name} marketplace`,
        detail: `Plugin with ${content.skills.length} ${content.skills.length === 1 ? "skill" : "skills"}`,
        // This is the first attachment's stored date, never an inferred re-add.
        occurredAt: membership.createdAt,
        href: getMarketplaceRoute(orgSlug, marketplace.id),
        action: "Browse",
      });
    }
  }

  // A skill can belong to several plugins. Fetch its versions only once, using
  // one currently visible parent as its valid destination and detail label.
  const skillsById = new Map<string, { skill: z.infer<typeof membershipSchema>["configObject"]; plugin: z.infer<typeof pluginSchema> }>();
  for (const { plugin, skills } of contents) {
    for (const skill of skills) {
      if (!skillsById.has(skill.id)) skillsById.set(skill.id, { skill, plugin });
    }
  }
  const versions = await mapConcurrent([...skillsById.values()], input.signal, async ({ skill, plugin }) => {
    // Resolved contents are freshly authorized on every visit. The immutable
    // latest-version ID, not a timestamp, determines whether history changed.
    const latestVersionId = skill.latestVersion?.id;
    const cached = latestVersionId ? input.versionCache?.get(skill.id, latestVersionId) : undefined;
    const skillVersions = cached ?? await readPages(input,
      `/v1/config-objects/${encodeURIComponent(skill.id)}/versions?limit=5&includeDeleted=false`,
      (payload) => pageSchema(versionSchema).parse(payload), ACTIVITY_LIMIT);
    if (skillVersions.some((version) => version.configObjectId !== skill.id)) {
      throw new Error("Activity version did not match its skill.");
    }
    if (!cached && latestVersionId) input.versionCache?.set(skill.id, latestVersionId, skillVersions);
    return { skill, plugin, versions: skillVersions };
  });
  for (const { skill, plugin, versions: skillVersions } of versions) {
    for (const version of skillVersions) {
      if (!version.createdAt || version.isDeletedVersion) continue;
      entries.push({
        id: `skill:${version.id}`,
        kind: "skill",
        title: `A new version of ${skill.title} was published`,
        detail: `Skill in ${plugin.name}`,
        occurredAt: version.createdAt,
        href: getPluginSkillRoute(orgSlug, plugin.id, skill.id),
        action: "Open",
      });
    }
  }
  input.signal.throwIfAborted();
  return newestDashboardActivity(entries);
}
