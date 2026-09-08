import { expect } from "vitest";
import { denFetch, freshSession } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { eventually, localMysqlIsRunning, needs, server, test } from "@openwork/testkit";

const ORGANIZATION_NAME = "Role Change Session Survival";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1" && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
const mysqlOpen = await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "role change session survival skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "role change session survival skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "role change session survival skipped — needs MySQL on 127.0.0.1:3306"
      : "role upgrades preserve live sessions while demotions revoke them";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(admin: DenSession): Promise<string> {
  const result = await denFetch(admin, "/v1/me/orgs", { headers: auth(admin) });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function memberIdByEmail(admin: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(admin, "/v1/org", {
    headers: {
      ...auth(admin),
      "x-openwork-org-id": orgId,
    },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const id = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the teammate membership failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function updateMemberRole(admin: DenSession, orgId: string, memberId: string, role: "admin" | "member"): Promise<void> {
  const privilegedAdmin = await freshSession(admin);
  const result = await denFetch(privilegedAdmin, `/v1/members/${encodeURIComponent(memberId)}/role`, {
    method: "POST",
    headers: {
      ...auth(privilegedAdmin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ role }),
  });
  expect(result.response.status).toBe(200);
}

async function sessionStatus(member: DenSession): Promise<number> {
  const result = await denFetch(member, "/v1/me", { headers: auth(member) });
  return result.response.status;
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      members: {
        teammate: { name: "Role Change Teammate" },
      },
    },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("The testkit did not provision the teammate session.");

  expect(await sessionStatus(teammate)).toBe(200);
  const orgId = await organizationId(den.admin);
  const teammateMemberId = await memberIdByEmail(den.admin, orgId, teammate.email);

  await updateMemberRole(den.admin, orgId, teammateMemberId, "admin");
  const promotedSessionStatus = await eventually(() => sessionStatus(teammate), {
    within: 10_000,
    label: "original member session after promotion",
    until: (status) => status === 200,
  });
  expect(promotedSessionStatus).toBe(200);
  evidence.recordAssertionEvidence(
    "A privilege upgrade preserves the member's live session",
    "The original member bearer token still returned HTTP 200 from /v1/me after promotion to admin.",
    promotedSessionStatus === 200,
  );

  await updateMemberRole(den.admin, orgId, teammateMemberId, "member");
  const demotedSessionStatus = await eventually(() => sessionStatus(teammate), {
    within: 10_000,
    label: "original member session revocation after demotion",
    until: (status) => status === 401,
  });
  expect(demotedSessionStatus).toBe(401);
  evidence.recordAssertionEvidence(
    "A privilege demotion revokes the member's live session",
    "The original member bearer token returned HTTP 401 from /v1/me after demotion to member.",
    demotedSessionStatus === 401,
  );
});
