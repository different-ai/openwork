import { queryDenDatabase, type Seed } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function memberFeatureEnablementWorld(seed: Seed) {
  const den = await seed.den({ org: {
    name: "Feature pilot workspace", admin: { name: "Pilot Admin" },
    members: { pilot: { name: "Pilot Member" }, peer: { name: "Other Member" } },
  } });
  const current = await seed.api(den.admin, "/v1/org");
  if (!isRecord(current.body) || !isRecord(current.body.organization) || typeof current.body.organization.id !== "string") throw new Error("Expected a seeded organization.");
  const organizationId = current.body.organization.id;
  const database = den.database?.url;
  if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("Member fixtures require an isolated testkit database.");
  const members = await queryDenDatabase(database, "SELECT id FROM member WHERE organization_id = ? AND user_id = (SELECT id FROM user WHERE email = ?) AND removed_at IS NULL", [organizationId, den.members.pilot.email]);
  const member = members[0];
  if (!isRecord(member) || typeof member.id !== "string") throw new Error("Expected a pilot membership.");
  const memberId = member.id;
  const organizationPath = `/v1/admin/organizations/${organizationId}/capabilities`;
  const setup = await seed.api(den.admin, organizationPath, { method: "PUT", body: JSON.stringify({ capabilities: { settledSessions: false } }) });
  if (!setup.response.ok) throw new Error("Could not set the organization baseline.");
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: `/admin/organizations/${organizationId}`, headless: true, viewport: { width: 1280, height: 900 } });
  const state = async () => {
    const [pilot, peer, settings] = await Promise.all([
      seed.api(den.members.pilot, "/v1/org"),
      seed.api(den.members.peer, "/v1/org"),
      seed.api(den.admin, `/v1/admin/organizations/${organizationId}/members/${memberId}/capabilities`),
    ]);
    if (!pilot.response.ok || !peer.response.ok || !settings.response.ok || !isRecord(pilot.body) || !isRecord(pilot.body.features) || !isRecord(peer.body) || !isRecord(peer.body.features) || !isRecord(settings.body) || !isRecord(settings.body.featureStates) || !isRecord(settings.body.featureStates.settledSessions)) throw new Error("Could not read member features.");
    return { pilot: pilot.body.features.settledSessions, peer: peer.body.features.settledSessions, override: settings.body.featureStates.settledSessions.override };
  };
  return { admin, memberId, state };
}
