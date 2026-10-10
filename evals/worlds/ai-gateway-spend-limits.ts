import type { Place, Seed } from "@openwork/env";
import { aiGatewayAdmin } from "./ai-gateway-admin.ts";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

const OTHER_TEAMS = [
  "Atlas launch planning with a deliberately long team label for small screens",
  "Beacon weekly reporting with a deliberately long team label for small screens",
  "Cedar meeting preparation with a deliberately long team label for small screens",
  "Delta release coordination with a deliberately long team label for small screens",
  "Elm checklist review with a deliberately long team label for small screens",
  "Finch account research with a deliberately long team label for small screens",
  "Grove project planning with a deliberately long team label for small screens",
  "Harbor document review with a deliberately long team label for small screens",
  "Iris follow-ups with a deliberately long team label for small screens",
  "Juniper launch readiness with a deliberately long team label for small screens",
  "Kestrel status reporting with a deliberately long team label for small screens",
  "WillowWithoutAnyWordBreaksToStressNarrowTeamMenusAndKeepTheSelectionIndicatorVisible",
];

/**
 * The AI Gateway admin world plus Design and twelve empty teams. The real Team
 * combobox must scroll and constrain long labels; only Design receives a limit.
 * No request reaches the gateway: limits are configured and read in Den only.
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
  const pickerTeams = [{ id: teamId, name: "Design" }];
  for (const name of OTHER_TEAMS) {
    const result = await seed.api(world.den.admin, "/v1/teams", {
      method: "POST", body: JSON.stringify({ name, memberIds: [] }),
    });
    const id = record(record(result.body).team).id;
    if (!result.response.ok || typeof id !== "string") throw new Error(`Team picker setup failed: ${result.text}`);
    pickerTeams.push({ id, name });
  }
  // The admin world's first browser predates these fixtures. Arrange the owner
  // surface after all teams exist, rather than relying on a warm query refetch.
  const web = await seed.web({
    den: world.den, signedInAs: world.den.admin,
    startPath: "/dashboard/ai-gateway?tab=limits", headless: true,
    viewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  return { ...world, web, teammateId, teamId, pickerTeams };
}
