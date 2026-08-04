import { timed } from "@openwork/timeline";
import { denFetch } from "./den.ts";
import type { DenSession } from "./den.ts";

/**
 * Authoring and sharing on the cloud side: a skill lives inside a plugin, and a
 * plugin becomes shareable by being assigned to a marketplace that colleagues
 * (or their teams) can use.
 *
 * These are plain API behaviours over the real den contract
 * (ee/apps/den-api/src/routes/org/plugin-system), so the same calls work from a
 * spec or a support script.
 */

export interface MarketplaceFacts {
  id: string;
  name: string;
}

export interface PluginFacts {
  id: string;
  name: string;
  componentIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireId(value: unknown, what: string, status: number, body: unknown): string {
  const item = isRecord(value) && isRecord(value.item) ? value.item : isRecord(value) ? value : null;
  const id = item && typeof item.id === "string" ? item.id : "";
  if (!id) throw new Error(`${what} did not return an id (status ${status}): ${JSON.stringify(body).slice(0, 300)}`);
  return id;
}

export async function createMarketplace(admin: DenSession, input: { name: string; description?: string }): Promise<MarketplaceFacts> {
  return timed("cloud.createMarketplace", async () => {
    const { response, body } = await denFetch(admin, "/v1/marketplaces", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ name: input.name, description: input.description ?? null }),
    });
    if (!response.ok) throw new Error(`Creating marketplace failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    return { id: requireId(body, "Creating a marketplace", response.status, body), name: input.name };
  });
}

/**
 * Create a plugin that CONTAINS a skill, and (optionally) publish it to a
 * marketplace in the same call — the contract supports both, which mirrors what
 * a person does in one sitting: author the skill, then share it.
 */
export async function createPluginWithSkill(
  admin: DenSession,
  input: { name: string; skillName: string; skillBody: string; marketplaceId?: string; orgWide?: boolean },
): Promise<PluginFacts> {
  return timed("cloud.createPluginWithSkill", async () => {
    const skillMarkdown = `---\nname: ${input.skillName}\ndescription: Shared by an eval to prove skill sharing works.\n---\n\n${input.skillBody}\n`;
    const { response, body } = await denFetch(admin, "/v1/plugins", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({
        name: input.name,
        description: "Created by the first-run cloud sharing eval.",
        orgWide: input.orgWide ?? true,
        marketplaceId: input.marketplaceId,
        components: [{ type: "skill", input: { rawSourceText: skillMarkdown } }],
      }),
    });
    if (!response.ok) throw new Error(`Creating plugin failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    const id = requireId(body, "Creating a plugin", response.status, body);
    const item = isRecord(body) && isRecord(body.item) ? body.item : {};
    const components = Array.isArray(item.components) ? item.components : [];
    const componentIds = components
      .map((component) => (isRecord(component) && typeof component.id === "string" ? component.id : ""))
      .filter((value) => value.length > 0);
    return { id, name: input.name, componentIds };
  });
}

export async function assignPluginToMarketplace(admin: DenSession, marketplaceId: string, pluginId: string): Promise<void> {
  await timed("cloud.assignPluginToMarketplace", async () => {
    const { response, body } = await denFetch(admin, `/v1/marketplaces/${marketplaceId}/plugins`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ pluginId }),
    });
    if (!response.ok) throw new Error(`Assigning plugin to marketplace failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
  });
}

/**
 * Give a colleague (or their team, or the whole org) access to the marketplace.
 * The API requires a role: viewer covers "can see and use what's shared".
 */
export async function grantMarketplaceAccess(
  admin: DenSession,
  marketplaceId: string,
  grant: ({ orgWide: true } | { orgMembershipId: string } | { teamId: string }) & { role?: "viewer" | "editor" | "manager" },
): Promise<void> {
  await timed("cloud.grantMarketplaceAccess", async () => {
    const { response, body } = await denFetch(admin, `/v1/marketplaces/${marketplaceId}/access`, {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ role: "viewer", ...grant }),
    });
    if (!response.ok) throw new Error(`Granting marketplace access failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
  });
}

export interface ResolvedMarketplaceFacts {
  pluginNames: string[];
  skillNames: string[];
  raw: unknown;
}

/**
 * What a member actually sees in a marketplace — read as that member, not the
 * admin. The resolved marketplace lists plugins (with component COUNTS only);
 * the skill names live on each plugin's own resolved components
 * (items[].configObject with objectType "skill" and the skill's title).
 */
export async function readResolvedMarketplace(member: DenSession, marketplaceId: string): Promise<ResolvedMarketplaceFacts> {
  return timed("cloud.readResolvedMarketplace", async () => {
    const { response, body } = await denFetch(member, `/v1/marketplaces/${marketplaceId}/resolved`, {
      headers: { authorization: `Bearer ${member.token}` },
    });
    if (!response.ok) throw new Error(`Reading the resolved marketplace failed (${response.status}): ${JSON.stringify(body).slice(0, 300)}`);
    const item = isRecord(body) && isRecord(body.item) ? body.item : isRecord(body) ? body : {};
    const plugins = Array.isArray(item.plugins) ? item.plugins : [];
    const pluginNames: string[] = [];
    const pluginIds: string[] = [];
    for (const plugin of plugins) {
      if (!isRecord(plugin)) continue;
      if (typeof plugin.name === "string") pluginNames.push(plugin.name);
      if (typeof plugin.id === "string") pluginIds.push(plugin.id);
    }
    const skillNames: string[] = [];
    for (const pluginId of pluginIds) {
      const resolved = await denFetch(member, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, {
        headers: { authorization: `Bearer ${member.token}` },
      });
      if (!resolved.response.ok) continue; // Not readable by this member = not visible to them.
      const items = isRecord(resolved.body) && Array.isArray(resolved.body.items) ? resolved.body.items : [];
      for (const component of items) {
        if (!isRecord(component) || !isRecord(component.configObject)) continue;
        const configObject = component.configObject;
        if (configObject.objectType !== "skill") continue;
        if (typeof configObject.title === "string" && configObject.title) skillNames.push(configObject.title);
      }
    }
    return { pluginNames, skillNames, raw: body };
  });
}
