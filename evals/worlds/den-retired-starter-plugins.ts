import { queryDenDatabase, type Place, type Seed } from "@openwork/env";
import { isRecord, records, stringField } from "./library.ts";

// What earlier Den builds seeded into every organization (default-marketplaces.ts keeps these to find old copies).
const STARTER_MARKETPLACE = {
  name: "Anthropic-Compatible Plugins",
  description: "Starter marketplace for Claude/Anthropic-compatible plugin repos. Example source: https://github.com/anthropics/knowledge-work-plugins.",
  logoUrl: "https://cdn.simpleicons.org/anthropic",
};
const EMPTY_STARTERS = ["PDF Viewer", "Legal"] as const;
const FILLED_STARTER = "Sales";

export interface StarterRow { name: string; status: string; contents: number }

/**
 * An organization created by an earlier Den build: the starter marketplace
 * still holds name-only "PDF Viewer" and "Legal" plugins that Den put there,
 * plus a "Sales" starter someone filled in with a skill. Nothing has listed
 * the org's marketplaces since, so the empty starters are still active when
 * the admin opens Manage › Plugins.
 */
export async function denRetiredStarterPlugins(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This world writes the legacy starter rows into Den's scratch database; run it on the local lane.");
  const den = await seed.den({
    org: {
      name: `Older organization ${Date.now()}`,
      admin: { name: "Riley Admin" },
      members: { maya: { name: "Maya Chen" } },
    },
  });
  const databaseUrl = den.database?.url ?? "";
  if (!databaseUrl) throw new Error("Expected the isolated Den database to seed the legacy starter rows.");

  const marketplace = await seed.api(den.admin, "/v1/marketplaces", {
    method: "POST",
    body: JSON.stringify({ name: STARTER_MARKETPLACE.name, description: STARTER_MARKETPLACE.description }),
  });
  const marketplaceBody = isRecord(marketplace.body) ? marketplace.body : null;
  const marketplaceId = stringField(isRecord(marketplaceBody?.item) ? marketplaceBody.item : marketplaceBody, "id");
  if (!marketplaceId) throw new Error(`Could not create the starter marketplace: HTTP ${marketplace.response.status} ${marketplace.text.slice(0, 300)}`);

  const skill = "---\nname: prep-a-sales-call\ndescription: Before any call with a customer\n---\n\nRead the account notes, then list three questions to ask.\n";
  for (const name of [...EMPTY_STARTERS, FILLED_STARTER]) {
    const created = await seed.api(den.admin, "/v1/plugins", {
      method: "POST",
      body: JSON.stringify({
        name,
        description: `${name} starter`,
        orgWide: true,
        marketplaceId,
        ...(name === FILLED_STARTER ? { components: [{ type: "skill", input: { rawSourceText: skill } }] } : {}),
      }),
    });
    if (!created.response.ok) throw new Error(`Could not create the ${name} starter: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  }
  // Earlier builds marked these as seeded by the system, with the starter logo; the API only creates manual ones.
  await queryDenDatabase(databaseUrl, "UPDATE marketplace SET logo_url = ? WHERE id = ?", [STARTER_MARKETPLACE.logoUrl, marketplaceId]);
  await queryDenDatabase(databaseUrl, "UPDATE marketplace_plugin SET membership_source = 'system' WHERE marketplace_id = ?", [marketplaceId]);

  async function starters(): Promise<StarterRow[]> {
    const rows = await queryDenDatabase(databaseUrl,
      `SELECT p.name AS name, p.status AS status,
        (SELECT COUNT(*) FROM plugin_config_object pco WHERE pco.plugin_id = p.id AND pco.removed_at IS NULL) AS contents
       FROM marketplace_plugin mp JOIN plugin p ON p.id = mp.plugin_id
       WHERE mp.marketplace_id = ? ORDER BY p.name`, [marketplaceId]);
    return rows.filter(isRecord).map((row) => ({ name: String(row.name), status: String(row.status), contents: Number(row.contents) }));
  }

  async function marketplaceStatus(): Promise<string> {
    const [row] = await queryDenDatabase(databaseUrl, "SELECT status FROM marketplace WHERE id = ?", [marketplaceId]);
    return isRecord(row) ? String(row.status) : "missing";
  }

  // Read before any page loads: opening Plugins is what should retire them.
  const before = { starters: await starters(), marketplace: await marketplaceStatus() };
  const viewport = { width: 1440, height: 1000 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/plugins", headless: true, viewport });

  return {
    den,
    web,
    before,
    emptyStarters: EMPTY_STARTERS,
    filledStarter: FILLED_STARTER,
    starters,
    marketplaceStatus,
    /** Plugin names in a person's My Library, straight from Den. */
    async library(person: "maya"): Promise<string[]> {
      const result = await seed.api(den.members[person], "/v1/me/library");
      if (!result.response.ok || !isRecord(result.body)) throw new Error(`Could not read the Library: HTTP ${result.response.status}`);
      return records(result.body.items).filter((item) => stringField(item, "type") === "plugin").map((item) => stringField(item, "name"));
    },
    async openAs(person: "maya", startPath: string) {
      return seed.web({ den, signedInAs: den.members[person], startPath, headless: true, viewport });
    },
  };
}
