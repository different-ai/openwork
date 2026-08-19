import { expect } from "vitest";
import { denFetch, provisionOrg } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { needs, server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function auth(session: DenSession, orgId: string): Record<string, string> {
  return {
    authorization: `Bearer ${session.token}`,
    "x-openwork-org-id": orgId,
  };
}

async function organizationIdByName(session: DenSession, name: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((item) => item.name === name);
  const orgId = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !orgId) {
    throw new Error(`Finding ${name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}

function telemetryEvent(sessionId: string, type: "session.active" | "task.started", model: string, selection: "default" | "manual") {
  return {
    type,
    timestamp: new Date().toISOString(),
    source: "app",
    sessionId,
    dimensions: [
      { type: "model", value: model, label: model },
      { type: "model_selection", value: selection, label: selection },
    ],
  };
}

async function readAnalytics(session: DenSession, orgId: string): Promise<Record<string, unknown>> {
  const result = await denFetch(session, "/v1/telemetry/analytics", {
    headers: auth(session, orgId),
    signal: AbortSignal.timeout(10_000),
  });
  if (result.response.status === 402) {
    throw new Error("Model analytics proof requires the local default DEN_PLAN_GATING_ENABLED=false; do not enable plan gating for this spec.");
  }
  if (!result.response.ok) {
    throw new Error(`Reading model analytics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return requireRecord(requireRecord(result.body, "analytics response").models, "analytics models");
}

test("organization model analytics aggregate session dimensions without cross-org leakage", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({});
  const primaryOrgName = `Model Analytics Primary ${Date.now()}`;
  await using den = await server({ place, org: { name: primaryOrgName } });
  const primaryOrgId = await organizationIdByName(den.admin, primaryOrgName);
  const otherOrg = await provisionOrg(den.ref, {});

  const events = [
    telemetryEvent("model-analytics-session-a", "session.active", "prov/model-a", "default"),
    telemetryEvent("model-analytics-session-a", "task.started", "prov/model-a", "default"),
    telemetryEvent("model-analytics-session-b", "session.active", "prov/model-b", "manual"),
    telemetryEvent("model-analytics-session-b", "task.started", "prov/model-b", "manual"),
  ];
  const ingested = await denFetch(den.admin, "/v1/telemetry/ingest", {
    method: "POST",
    headers: auth(den.admin, primaryOrgId),
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(10_000),
  });
  expect(ingested.response.status).toBe(204);

  const primaryModels = await readAnalytics(den.admin, primaryOrgId);
  const usage30d = Array.isArray(primaryModels.usage30d) ? primaryModels.usage30d : [];
  expect(usage30d).toHaveLength(2);
  expect(usage30d).toEqual(expect.arrayContaining([
    { id: "prov/model-a", label: "prov/model-a", sessions: 1 },
    { id: "prov/model-b", label: "prov/model-b", sessions: 1 },
  ]));
  expect(primaryModels.selection30d).toEqual({ default: 1, manual: 1 });
  evidence.recordAssertionEvidence(
    "Model usage is aggregated by distinct session",
    JSON.stringify(usage30d),
    usage30d.length === 2,
  );
  evidence.recordAssertionEvidence(
    "Default and manual model selections are counted",
    JSON.stringify(primaryModels.selection30d),
    isRecord(primaryModels.selection30d)
      && primaryModels.selection30d.default === 1
      && primaryModels.selection30d.manual === 1,
  );

  const otherModels = await readAnalytics(otherOrg.admin, otherOrg.orgId);
  expect(otherModels.usage30d).toEqual([]);
  expect(otherModels.selection30d).toEqual({ default: 0, manual: 0 });
  evidence.recordAssertionEvidence(
    "Model analytics are isolated by organization",
    JSON.stringify(otherModels),
    Array.isArray(otherModels.usage30d) && otherModels.usage30d.length === 0,
  );
});
