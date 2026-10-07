import type { DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { setPermissionsFeature, type PermissionsCall } from "./permissions.ts";

/**
 * Den Web for the Permissions screens. One organization, Permissions off:
 *   - Olivia, the owner (also the deployment's platform admin, who turns features on),
 *   - Maya, a member of the Support team,
 *   - Nora, a member in no team.
 * Each person has their own signed-in browser.
 */

const ORGANIZATION_NAME = "Permissions UI workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} was missing from the Den response`);
  return value;
}

export async function permissionsUiWorld(seed: Seed) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Olivia Owner", email: `permissions-ui-owner+${stamp}@example.test` },
      members: {
        maya: { name: "Maya Member", email: `permissions-ui-maya+${stamp}@example.test` },
        nora: { name: "Nora Newcomer", email: `permissions-ui-nora+${stamp}@example.test` },
      },
    },
  });
  const owner = den.admin;
  const { maya, nora } = den.members;
  if (!maya || !nora) throw new Error("The testkit did not provision every member session");

  const orgs = await seed.api(owner, "/v1/me/orgs");
  const orgList = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : [];
  const orgId = text(orgList.find((org) => org.name === ORGANIZATION_NAME)?.id, "organization id");
  const scope = { "x-openwork-org-id": orgId };

  const roster = await seed.api(owner, "/v1/org", { headers: scope });
  const members = isRecord(roster.body) && Array.isArray(roster.body.members) ? roster.body.members.filter(isRecord) : [];
  const memberId = (session: DenSession) => text(
    members.find((member) => isRecord(member.user) && member.user.email === session.email)?.id,
    `member id for ${session.email}`,
  );
  const ids = { owner: memberId(owner), maya: memberId(maya), nora: memberId(nora) };

  const created = await seed.api(owner, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Support", memberIds: [ids.maya] }) });
  const team = isRecord(created.body) && isRecord(created.body.team) ? created.body.team : null;
  if (created.response.status !== 201 || !team) throw new Error(`Creating the Support team failed: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
  const supportTeamId = text(team.id, "Support team id");

  const viewport = { width: 1280, height: 900 };
  const ownerWeb = await seed.web({ den, signedInAs: owner, startPath: "/dashboard", headless: true, viewport });
  const mayaWeb = await seed.web({ den, signedInAs: maya, startPath: "/dashboard", headless: true, viewport });
  const noraWeb = await seed.web({ den, signedInAs: nora, startPath: "/dashboard", headless: true, viewport });

  return {
    den,
    orgId,
    owner,
    maya,
    nora,
    ids,
    supportTeamId,
    ownerWeb,
    mayaWeb,
    noraWeb,
    /** Absolute Den Web URL for a dashboard path. */
    url(path: string): string {
      return new URL(path, den.ref.webUrl).toString();
    },
    /** A platform administrator turns Permissions on or off for this organization from /admin. */
    setPermissions(enabled: boolean): Promise<PermissionsCall> {
      return setPermissionsFeature(owner, orgId, enabled);
    },
    /** Request headers that pin a Den call to this organization. */
    scope,
  };
}

export type PermissionsUiWorld = Awaited<ReturnType<typeof permissionsUiWorld>>;
