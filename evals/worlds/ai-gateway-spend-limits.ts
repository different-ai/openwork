import type { Place, Seed } from "@openwork/env";
import { aiGatewayAdmin } from "./ai-gateway-admin.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * The AI Gateway admin world plus a Design team holding the teammate, so the
 * owner can give a team per-day and per-month spend limits. No request ever
 * reaches the gateway: limits are configured and read in Den only.
 */
export async function aiGatewaySpendLimits(seed: Seed, context: { place: Place }) {
  const world = await aiGatewayAdmin(seed, context);
  const teammateOrg = record((await seed.api(world.teammate, "/v1/org")).body);
  const teammateId = String(record(teammateOrg.currentMember).id);
  const created = await seed.api(world.den.admin, "/v1/teams", {
    method: "POST", body: JSON.stringify({ name: "Design", memberIds: [teammateId] }),
  });
  if (!created.response.ok) throw new Error(`Design team setup failed: ${created.text}`);
  const teamId = String(record(record(created.body).team).id);
  return { ...world, teammateId, teamId };
}
