import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/**
 * Acme, owned by Avery, with Riley as a regular member in the Finance team.
 * Avery's browser opens the old Teams tab link; Riley's opens the dashboard.
 */
export async function organizationSidebarWorld(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: { name: "Acme", admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Finance" } } },
  });
  const { riley } = den.members;
  if (!riley) throw new Error("seed.den() did not provision the member session");

  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  if (!context.response.ok || typeof organization?.id !== "string") throw new Error(`Reading the organization failed: ${context.text.slice(0, 500)}`);
  const rileyId = (isRecord(context.body) ? records(context.body.members) : []).find((member) => isRecord(member.user) && member.user.name === "Riley Finance")?.id;
  if (typeof rileyId !== "string") throw new Error("Riley is not a member of the organization");
  const team = await seed.api(den.admin, "/v1/teams", {
    method: "POST",
    headers: { "x-openwork-org-id": organization.id },
    body: JSON.stringify({ name: "Finance", memberIds: [rileyId] }),
  });
  if (!team.response.ok) throw new Error(`Setting up Finance failed: ${team.text.slice(0, 500)}`);

  const viewport = { width: 1280, height: 900 };
  const owner = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members?tab=teams", headless: true, viewport });
  const member = await seed.web({ den, signedInAs: riley, startPath: "/dashboard", headless: true, viewport });
  return { den, owner, member };
}
