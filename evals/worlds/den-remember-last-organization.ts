import { signIn, type DenSession } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { seededOrganizationId } from "./organization-capabilities.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function denMemoryRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an organization or authenticated identity response.");
  return value;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty response field.");
  return value;
}

/** Real Den web sign-ins; no preference, browser token, or remembered org is injected. */
export async function denRememberLastOrganization(seed: Seed) {
  const den = await seed.den({
    org: {
      name: "Organization A",
      admin: { name: "Memory Operator" },
      members: {
        returning: { name: "Returning Member" },
        other: { name: "Another Member" },
      },
    },
    env: {
      DEN_ORG_MODE: "multi_org", DEN_DEPLOYMENT: "cloud",
      DEN_REQUIRE_EMAIL_VERIFICATION: "false", DEN_PASSWORD_BREACH_SCREENING_ENABLED: "false",
      OPENWORK_DEV_MODE: "1", RESEND_API_KEY: "", SMTP_HOST: "",
    },
  });
  const organizationA = { id: await seededOrganizationId(seed, den.admin), name: "Organization A" };
  if (!organizationA.id) throw new Error("The first organization must be provisioned.");
  const created = await seed.api(den.admin, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: "Organization B" }),
  });
  if (!created.response.ok) throw new Error(`Create organization: HTTP ${created.response.status}`);
  const organizationB = {
    id: requiredString(denMemoryRecord(denMemoryRecord(created.body).organization).id),
    name: "Organization B",
  };
  const returning = den.members.returning;
  const other = den.members.other;
  if (!returning || !other) throw new Error("Both verified member accounts must be provisioned.");

  for (const member of [returning, other]) {
    const invitation = await seed.api(den.admin, "/v1/invitations", {
      method: "POST", headers: { "x-openwork-org-id": organizationB.id },
      body: JSON.stringify({ email: member.email, role: "member" }),
    });
    if (!invitation.response.ok) throw new Error(`Invite member: HTTP ${invitation.response.status}`);
    const accepted = await seed.api(member, "/v1/orgs/invitations/accept", {
      method: "POST", body: JSON.stringify({ id: requiredString(denMemoryRecord(invitation.body).inviteToken) }),
    });
    if (!accepted.response.ok || denMemoryRecord(accepted.body).accepted !== true) {
      throw new Error(`Join organization: HTTP ${accepted.response.status}`);
    }
  }

  const identity = async (session: DenSession) => {
    const result = await seed.api(session, "/v1/me");
    if (!result.response.ok) throw new Error(`Verify identity: HTTP ${result.response.status}`);
    return { session, userId: requiredString(denMemoryRecord(denMemoryRecord(result.body).user).id) };
  };
  const first = await identity(returning);
  const anotherAccount = await identity(other);
  // An independent, newly authenticated session is deliberately in A. Public
  // API witnesses compare it with the browser's explicit and remembered B;
  // account-global/default-B behavior cannot satisfy that contrast.
  const freshSessionInA = await signIn(den.ref, { email: returning.email, password: returning.password });
  const selected = await seed.api(freshSessionInA, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: organizationA.id }),
  });
  if (!selected.response.ok) throw new Error(`Arrange fresh session in A: HTTP ${selected.response.status}`);
  const web = await seed.web({ den, startPath: "/", headless: true, viewport: { width: 1440, height: 1000 } });
  return { den, web, organizationA, organizationB, first, anotherAccount, freshSessionInA };
}
