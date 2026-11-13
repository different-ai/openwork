import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/** An owner, another administrator, and a read-only teammate in one isolated organization. */
export async function denPageInteractionsWorld(seed: Seed) {
  const den = await seed.den({
    org: { name: "Page consistency studio", admin: { name: "Page Owner" }, members: {
      legacy: { name: "Legacy Administrator" }, viewer: { name: "Page Viewer" },
    } },
    env: { DEN_PLAN_GATING_ENABLED: "false", DEN_AUDIT_VISIBILITY_ENABLED: "true", DEN_AUDIT_CAPTURE_ENABLED: "true" },
  });
  const context = await seed.api(den.admin, "/v1/org");
  if (!context.response.ok || !isRecord(context.body) || !isRecord(context.body.organization) || typeof context.body.organization.id !== "string") throw new Error("Missing page consistency organization");
  const organizationId = context.body.organization.id;
  const scope = { "x-openwork-org-id": organizationId };
  const members = records(context.body.members);
  const memberId = (email: string) => {
    const member = members.find(entry => isRecord(entry.user) && entry.user.email === email);
    if (typeof member?.id !== "string") throw new Error("Missing page consistency member");
    return member.id;
  };
  const legacyId = memberId(den.members.legacy.email);
  const viewerId = memberId(den.members.viewer.email);
  const promotion = await seed.api(den.admin, `/v1/members/${legacyId}/role`, {
    method: "POST", headers: scope, body: JSON.stringify({ role: "super-admin" }),
  });
  if (!promotion.response.ok) throw new Error(`Cannot prepare administrator: ${promotion.text}`);
  const team = await seed.api(den.admin, "/v1/teams", {
    method: "POST", headers: scope, body: JSON.stringify({ name: "Readers", memberIds: [viewerId] }),
  });
  if (!team.response.ok || !isRecord(team.body) || !isRecord(team.body.team) || typeof team.body.team.id !== "string") throw new Error(`Cannot prepare Readers: ${team.text}`);
  const teamId = team.body.team.id;
  const role = await seed.api(den.admin, "/v1/permissions/sets", {
    method: "POST", headers: scope, body: JSON.stringify({ teamId, permissions: [
      { key: "teams.view", status: "allow" }, { key: "audit.view", status: "allow" },
      // Directory entry access is not permission to manage another person's plugin grants.
      { key: "plugins.import", status: "allow" },
    ] }),
  });
  if (!role.response.ok) throw new Error(`Cannot prepare read-only role: ${role.text}`);
  const plugin = await seed.api(den.admin, "/v1/plugins", { method: "POST", headers: scope, body: JSON.stringify({
    name: "Shared guide", description: "A synthetic sharing boundary fixture", components: [],
  }) });
  if (!plugin.response.ok || !isRecord(plugin.body) || !isRecord(plugin.body.item) || typeof plugin.body.item.id !== "string") throw new Error(`Cannot prepare sharing fixture: ${plugin.text}`);
  const pluginId = plugin.body.item.id;
  const grant = await seed.api(den.admin, `/v1/plugins/${pluginId}/access`, { method: "POST", headers: scope,
    body: JSON.stringify({ orgMembershipId: viewerId, role: "viewer" }),
  });
  if (!grant.response.ok) throw new Error(`Cannot prepare viewer grant: ${grant.text}`);
  const viewport = { width: 1440, height: 1000 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/org-settings", headless: true, viewport });
  const legacy = await seed.web({ den, signedInAs: den.members.legacy, startPath: "/dashboard/org-settings", headless: true, viewport });
  const viewer = await seed.web({ den, signedInAs: den.members.viewer, startPath: "/dashboard/org-settings", headless: true, viewport });
  return {
    owner, legacy, viewer, teamId, pluginId,
    async pluginAudience() {
      const result = await seed.api(den.admin, `/v1/plugins/${pluginId}/access`);
      if (!result.response.ok || !isRecord(result.body)) throw new Error("Cannot read sharing fixture");
      return records(result.body.items).filter(entry => entry.removedAt === null);
    },
    url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    async organizationName() {
      const current = await seed.api(den.admin, "/v1/org");
      if (!current.response.ok || !isRecord(current.body) || !isRecord(current.body.organization)) throw new Error("Cannot read saved organization name");
      return current.body.organization.name;
    },
  };
}
