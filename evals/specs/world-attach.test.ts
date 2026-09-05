import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  createAdmin,
  createOrg,
  defaultReuseAdmin,
  inviteMember,
  localMysqlIsRunning,
  localRedisIsRunning,
  needs,
  server,
  SkipError,
  test,
} from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizations(session: DenSession): Promise<Map<string, string>> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.orgs)) {
    throw new Error(`Organization list failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const listed = new Map<string, string>();
  for (const organization of result.body.orgs) {
    if (!isRecord(organization) || typeof organization.name !== "string" || typeof organization.id !== "string") continue;
    listed.set(organization.name, organization.id);
  }
  return listed;
}

test("a script world attaches to an existing Den without owning it", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ placement: "local" });
  if (!await localMysqlIsRunning()) {
    throw new SkipError("local MySQL on 127.0.0.1:3306");
  }
  if (!await localRedisIsRunning()) {
    throw new SkipError("local Redis on 127.0.0.1:6379");
  }

  const nonce = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const preexistingOrgName = `Attach Outer ${nonce}`;
  const attachedOrgName = `Attach World ${nonce}`;
  const resolvedEmail = `attach-member+${nonce}@openwork.test`;
  const resolvedPassword = `AttachSecret-${nonce}!`;

  await using stack = new AsyncDisposableStack();
  const outer = stack.use(await server({ place, provision: false, web: false }));
  await createAdmin(outer, defaultReuseAdmin());
  const preexistingOrg = stack.use(await createOrg(outer, preexistingOrgName));
  const before = await organizations(outer.admin);
  expect(before.get(preexistingOrgName)).toBe(preexistingOrg.id);

  {
    await using attachedStack = new AsyncDisposableStack();
    const attached = attachedStack.use(await server({
      place,
      provision: false,
      reuse: outer.ref,
      web: false,
    }));
    await createAdmin(attached, defaultReuseAdmin());
    attachedStack.use(await createOrg(attached, attachedOrgName));
    const jordan = await inviteMember(attached, "jordan", {
      email: resolvedEmail,
      name: "Jordan",
      password: resolvedPassword,
    });
    const attachedOrganizations = await organizations(attached.admin);
    expect(attachedOrganizations.has(attachedOrgName)).toBe(true);
    expect(jordan.email).toBe(resolvedEmail);
    evidence.recordAssertionEvidence(
      "The script used an authenticated admin session on the attached Den",
      [...attachedOrganizations.keys()].join(", "),
      attachedOrganizations.has(attachedOrgName),
    );
  }

  const health = await fetch(`${outer.ref.apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
  expect(health.ok).toBe(true);
  const after = await organizations(outer.admin);
  expect(after.get(preexistingOrgName)).toBe(preexistingOrg.id);
  expect(after.has(attachedOrgName)).toBe(false);
  evidence.recordAssertionEvidence(
    "Disposing the attached script left the outer Den healthy",
    `HTTP ${health.status}`,
    health.ok,
  );
  evidence.recordAssertionEvidence(
    "Disposal deleted only the script-created organization",
    [...after.keys()].join(", "),
    after.get(preexistingOrgName) === preexistingOrg.id && !after.has(attachedOrgName),
  );
});
