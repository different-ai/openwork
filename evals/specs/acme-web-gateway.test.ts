import assert from "node:assert/strict";
import { eventually, queryDenDatabase, test } from "@openwork/testkit";
import { bootAcmeWeb } from "../../worlds/acme-web.ts";
import { ACME_MODEL, ACME_REPLY, record } from "../../worlds/lib/acme-gateway.ts";
import { probeAcmeGateway } from "../../worlds/lib/acme-gateway-probe.ts";
import { denFetch } from "@openwork/behaviors";

test("Acme web routes a managed model through the real AI Gateway", { timeout: 600_000 }, async ({ evidence }) => {
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeWeb(stack);
  const cors = await fetch(`${world.den.ref.apiUrl}/v1/me/orgs`, { method: "OPTIONS", headers: {
    origin: world.web.manifest.webUrl, "access-control-request-method": "GET", "access-control-request-headers": "authorization",
  } });
  assert.equal(cors.headers.get("access-control-allow-origin"), world.web.manifest.webUrl);
  assert.match(world.model.providerId, /^ipr_/);
  assert.match(world.model.modelId, /^gwm_/);
  assert.notEqual(world.model.modelName, world.model.modelId);
  const result = await probeAcmeGateway(world);
  assert.equal(result.reply, ACME_REPLY);
  assert.ok(result.upstreamRequests > 0);
  const databaseUrl = world.den.database?.url;
  assert.ok(databaseUrl);
  const rows = await eventually(() => queryDenDatabase(databaseUrl,
    "SELECT organization_id, requested_model, upstream_model, input_tokens, output_tokens, cost_micro_usd, completed_at FROM gateway_request_logs WHERE gateway_provider_id = ? AND outcome = 'ok'",
    [world.model.providerId]), {
    within: 15_000, intervalMs: 250, label: "Acme Gateway finalized usage",
    until: (rows) => rows.some((row) => record(row) && row.completed_at != null),
  });
  const usage = rows.find((row) => record(row) && row.completed_at != null);
  assert.ok(record(usage));
  assert.equal(usage.organization_id, world.model.orgId);
  assert.equal(usage.requested_model, world.model.modelId);
  assert.equal(usage.upstream_model, ACME_MODEL);
  assert.equal(Number(usage.input_tokens), 25);
  assert.equal(Number(usage.output_tokens), 12);
  assert.ok(Number(usage.cost_micro_usd) > 0);
  const before = world.upstream.requests.length;
  const denied = await fetch(`${world.gatewayUrl}/api/v1/providers/${world.model.providerId}/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "invalid-fixture-key" },
    body: JSON.stringify({ model: world.model.modelId, max_tokens: 32, messages: [{ role: "user", content: "deny" }] }),
  });
  assert.equal(denied.status, 401);
  assert.equal(world.upstream.requests.length, before);
  const headers = { authorization: `Bearer ${world.den.admin.token}`, "x-openwork-org-id": world.model.orgId };
  const grants = await denFetch(world.den.admin, `/v1/inference-providers/${world.model.providerId}/access-grants`, { headers });
  assert.equal(grants.response.status, 200);
  const grant = record(grants.body) && Array.isArray(grants.body.accessGrants) ? grants.body.accessGrants.find(record) : undefined;
  assert.equal(typeof grant?.id, "string");
  const connection = await denFetch(world.den.admin, `/v1/inference-providers/${world.model.providerId}/connect`, { headers });
  const provider = record(connection.body) && record(connection.body.inferenceProvider) ? connection.body.inferenceProvider : undefined;
  assert.ok(provider && typeof provider.apiKey === "string");
  const revoked = await denFetch(world.den.admin, `/v1/inference-providers/${world.model.providerId}/access-grants/${grant?.id}`, { method: "DELETE", headers });
  assert.equal(revoked.response.status, 204);
  const deniedAfterRevoke = await fetch(`${world.gatewayUrl}/api/v1/providers/${world.model.providerId}/messages`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": provider.apiKey },
    body: JSON.stringify({ model: world.model.modelId, max_tokens: 32, messages: [{ role: "user", content: "deny" }] }),
  });
  assert.equal(deniedAfterRevoke.status, 403);
  assert.equal(world.upstream.requests.length, before);
  evidence.recordAssertionEvidence("Acme web uses the real AI Gateway", "A cold seeded Acme Den materialized an ipr provider and friendly gwm model title into real OpenCode. Chat returned the upstream reply through the actual gateway and finalized model/token/cost attribution. Invalid keys and revoked grants were denied before upstream. Upstream secrets were absent from runtime config.", true);
});
