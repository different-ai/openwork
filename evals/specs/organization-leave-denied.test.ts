import { expect } from "vitest";
import { denFetch, type DenSession } from "@openwork/behaviors";
import { server, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a nonempty string");
  return value;
}

test("raw Better Auth organization leave is denied and keeps the membership", { timeout: 300_000 }, async ({ place, evidence }) => {
  await using den = await server({ place, web: false, org: { name: "Raw Leave Boundary", members: { member: {} } } });
  const owner = den.admin;
  const member = den.members.member;
  if (!member) throw new Error("Missing test member");

  const orgs = record((await denFetch(owner, "/v1/me/orgs", { headers: { authorization: `Bearer ${owner.token}` } })).body).orgs;
  if (!Array.isArray(orgs)) throw new Error("Missing organizations");
  const orgId = text(record(orgs.find((org) => record(org).name === "Raw Leave Boundary")).id);
  const orgContext = (session: DenSession) => denFetch(session, "/v1/org", {
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
  });

  for (const session of [member, owner]) {
    const signedIn = await denFetch(session, "/api/auth/sign-in/email", { method: "POST", body: JSON.stringify({ email: session.email, password: session.password }) });
    const cookie = signedIn.response.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Missing raw BetterAuth session cookie");
    const left = await denFetch(session, "/api/auth/organization/leave", { method: "POST", headers: { cookie }, body: JSON.stringify({ organizationId: orgId }) });
    expect(left.response.status, left.text).toBe(403);
    const context = await orgContext(session);
    expect(context.response.status, context.text).toBe(200);
    expect(text(record(record(context.body).currentMember).id)).toBeTruthy();
  }

  evidence.recordAssertionEvidence(
    "Raw organization leave cannot bypass Den member removal",
    "A plain member and the owner each call POST /api/auth/organization/leave with a valid Better Auth session and get 403; both still load the workspace afterwards.",
    true,
  );
});
