import { signIn, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { denForAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function memoryRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an organization or identity response.");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty response field.");
  return value;
}

/**
 * Real Den accounts, memberships and independent, single-use handoff grants.
 * Organization memory is generally available; no feature overrides are seeded.
 * No preference or credential is injected into the app: every sign-in happens
 * through the sidebar's manual-paste UI after arrangement ends.
 */
export async function rememberLastOrganization(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed, {
    org: {
      name: "Organization A",
      admin: { name: "Memory Operator" },
      members: {
        returning: { name: "Returning Member" },
        other: { name: "Another Member" },
      },
    },
  });
  const organizationA = { id: await seededOrganizationId(seed, den.admin), name: "Organization A" };
  const createOrganization = async (name: string) => {
    const created = await seed.api(den.admin, "/v1/org", {
      method: "POST", body: JSON.stringify({ name }),
    });
    if (!created.response.ok) throw new Error(`Create organization: HTTP ${created.response.status} ${created.text.slice(0, 300)}`);
    return { id: requiredString(memoryRecord(memoryRecord(created.body).organization).id), name };
  };
  const organizationB = await createOrganization("Organization B");
  const organizationC = await createOrganization("Organization C");
  const returning = den.members.returning;
  const other = den.members.other;
  if (!returning || !other) throw new Error("Both real member accounts must be provisioned.");

  for (const organization of [organizationB, organizationC]) {
    for (const member of [returning, other]) {
      const invitation = await seed.api(den.admin, "/v1/invitations", {
        method: "POST",
        headers: { "x-openwork-org-id": organization.id },
        body: JSON.stringify({ email: member.email, role: "member" }),
      });
      if (!invitation.response.ok) throw new Error(`Invite member: HTTP ${invitation.response.status}`);
      const accepted = await seed.api(member, "/v1/orgs/invitations/accept", {
        method: "POST",
        body: JSON.stringify({ id: requiredString(memoryRecord(invitation.body).inviteToken) }),
      });
      if (!accepted.response.ok || memoryRecord(accepted.body).accepted !== true) {
        throw new Error(`Join organization: HTTP ${accepted.response.status} ${accepted.text.slice(0, 300)}`);
      }
    }
  }

  const app = await seed.appWeb({
    den: den.ref, webPort, mouse: true, headless: true,
    workspacePath: seed.tmpPath("remember-organization"),
  });
  await seed.workspace(app, app.workspaceRoot);

  // Mint only after the slow app boot: real grants expire after five minutes.
  // Each grant has its own login session. Signing out of the first must not
  // revoke the later grant, which exchanges to its source session's token.
  const handoff = async (member: DenSession) => {
    const session = await signIn(den.ref, { email: member.email, password: member.password });
    const selected = await seed.api(session, "/v1/me/active-organization", {
      method: "POST", body: JSON.stringify({ organizationId: organizationA.id }),
    });
    if (!selected.response.ok) throw new Error(`Arrange session in A: HTTP ${selected.response.status}`);
    const identity = await seed.api(session, "/v1/me");
    if (!identity.response.ok) throw new Error(`Verify identity: HTTP ${identity.response.status}`);
    const userId = requiredString(memoryRecord(memoryRecord(identity.body).user).id);
    const issued = await seed.api(session, "/v1/auth/desktop-handoff", {
      method: "POST", body: JSON.stringify({ desktopScheme: "openwork" }),
    });
    if (!issued.response.ok) throw new Error(`Issue handoff: HTTP ${issued.response.status}`);
    return { session, userId, grant: requiredString(memoryRecord(issued.body).grant) };
  };
  const first = await handoff(returning);
  const returningLogin = await handoff(returning);
  const restored = await handoff(returning);
  const anotherAccount = await handoff(other);
  if (new Set([first, returningLogin, restored, anotherAccount].map(({ session }) => session.token)).size !== 4) {
    throw new Error("Every handoff must use an independent, freshly authenticated session.");
  }

  return { app, den, organizationA, organizationB, organizationC, first, returningLogin, restored, anotherAccount };
}
