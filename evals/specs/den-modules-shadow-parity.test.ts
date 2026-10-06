import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import { localMysqlIsRunning, needs, server, SkipError, test } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return Object.fromEntries(Object.entries(value));
}

function logEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n").flatMap((line) => {
    if (!line.trim().startsWith("{")) return [];
    try {
      return [record(JSON.parse(line))];
    } catch {
      return [];
    }
  });
}

// Plan W0-03: den-api builds the module runtime at boot and, on every org request, compares
// today's capability, plan and env helpers with the resolver. Untagged mismatches are adapter
// bugs; tagged ones are the known graph divergences (00-legacy-mapping §F).
test("den-api shadow-compares legacy gates with the module resolver and finds no untagged mismatch", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ commands: ["pnpm"], placement: "local" });
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306 for an isolated, migrated Den database");
  const organizationName = `Modules Shadow ${Date.now()}`;
  await using den = await server({
    place,
    web: false,
    schema: "migrate",
    org: { name: organizationName },
    env: { DEN_PLAN_GATING_ENABLED: "true", DEN_MODULES_SHADOW_COMPARE: "true" },
  });

  const authed = { authorization: `Bearer ${den.admin.token}` };
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers: authed });
  expect(orgs.response.status, orgs.text).toBe(200);
  const listed = record(orgs.body).orgs;
  if (!Array.isArray(listed)) throw new Error("Expected an org list");
  const orgId = String(record(listed.map(record).find((org) => org.name === organizationName)).id);
  const orgHeaders = { ...authed, "x-openwork-org-id": orgId };

  const admin = async (path: string, method: string, body: unknown) => {
    const response = await denFetch(den.admin, `/v1/admin/organizations/${orgId}${path}`, { method, headers: authed, body: JSON.stringify(body) });
    expect(response.response.status, `${method} ${path}: ${response.text}`).toBe(200);
  };
  const readOrg = async () => {
    const context = await denFetch(den.admin, "/v1/org", { headers: orgHeaders });
    expect(context.response.status, context.text).toBe(200);
  };

  const steps: Array<{ tier: "free" | "team" | "enterprise"; capabilities: Record<string, boolean | null> }> = [
    { tier: "free", capabilities: {} },
    { tier: "team", capabilities: { workbot: true, auditLogs: true, orgManagedDashboards: true } },
    { tier: "enterprise", capabilities: { headlessAutomations: true, slackAssistant: true, slackAssistantHeadless: true, modelsAnalytics: true } },
    { tier: "free", capabilities: { installLinks: false, workbot: false, headlessAutomations: null } },
    { tier: "team", capabilities: { installLinks: null, auditLogs: false, orgManagedDashboards: null } },
  ];
  for (const step of steps) {
    await admin("/plan", "PATCH", { tier: step.tier, seatLimit: 25 });
    await admin("/capabilities", "PUT", { capabilities: step.capabilities });
    await readOrg();
  }

  // A known divergence (G2): OpenWork Web hard-depends on connect, which legacy gates ignore.
  await admin("/openwork-web-access", "PUT", { enabled: true, reason: "shadow parity spec" });
  await admin("/capabilities", "PUT", { capabilities: { mcpConnections: false } });
  await readOrg();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const events = logEvents(await den.apiLog());
  const named = (message: string) => events.filter((event) => event.message === message);
  const booted = named("den_modules_deployment");
  expect(booted, "den-api logs the module runtime it built at boot").toHaveLength(1);
  expect(booted[0]).toMatchObject({ source: "derived", entitlementMode: "legacy", shadowCompare: true });
  expect(["cloud", "selfHosted"]).toContain(booted[0]?.deployment);

  const mismatches = named("den_modules_shadow_mismatch").filter((event) => event.organizationId === orgId);
  const untagged = mismatches.filter((event) => event.knownDivergence === null);
  expect(untagged, JSON.stringify(untagged)).toEqual([]);
  expect(mismatches.map((event) => [event.oracle, event.knownDivergence])).toContainEqual(["org.capabilities.openworkWeb", "G2"]);
  expect(named("den_modules_legacy_mirror_mismatch")).toEqual([]);
  expect(named("den_modules_shadow_failed")).toEqual([]);

  evidence.recordAssertionEvidence(
    "Shadow compare finds no untagged mismatch",
    `On a ${String(booted[0]?.deployment)} Den, across ${steps.length} plan and capability combinations with DEN_PLAN_GATING_ENABLED=true, GET /v1/org shadow-compared every legacy helper with the resolver: ${mismatches.length} mismatches, all tagged known divergences (including G2 for OpenWork Web without connect), no mirror mismatch and no comparison failure.`,
    true,
  );
});
