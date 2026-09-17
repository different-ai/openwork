import { expect } from "vitest";
import { localMysqlIsRunning, needs, server, SkipError, test } from "@openwork/testkit";
import type { GatewayRouterDefinition } from "@openwork/types/den/gateway-router";
import { api, orgId, record, routerGateway, routerUpstream, rows, text } from "../worlds/gateway-router.ts";

test("member creates a persistent private router and routes through live grants", { timeout: 600_000 }, async ({ place, evidence }) => {
  needs({ commands: ["pnpm", "bun"] });
  if (place.kind !== "local" || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new SkipError("co-located scratch MySQL, Den and Gateway required; remote fixture unavailable");
  }
  if (!await localMysqlIsRunning()) throw new SkipError("MySQL on 127.0.0.1:3306");
  await using upstream = await routerUpstream();
  const name = `Router journey ${Date.now()}`;
  await using den = await server({ place, web: false,
    env: { NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", GATEWAY_ENABLED: "true",
      GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:19999", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:19999",
      GATEWAY_EGRESS_ALLOWED_ORIGINS: upstream.baseUrl },
    org: { name, admin: { name: "Router Admin" }, members: { owner: { name: "Router Owner" }, other: { name: "Other Member" } } },
  });
  const databaseUrl = den.database?.url;
  if (!databaseUrl || !new URL(databaseUrl).pathname.startsWith("/openwork_eval_")) throw new Error("Scratch DB required");
  const owner = den.members.owner, other = den.members.other;
  if (!owner || !other) throw new Error("Missing fixture members");
  const organization = await orgId(den.admin, name);
  const members = rows(record((await api(den.admin, organization, "/v1/org")).body).members);
  const adminMemberId = text(members.find((member) => record(member.user).email === den.admin.email)?.id);
  const createProvider = async (allMembers: boolean) => {
    const result = await api(den.admin, organization, "/v1/inference-providers", "POST", {
      name: allMembers ? "Shared OpenAI" : "Inaccessible OpenAI", providerId: "openai", modelIds: ["gpt-4o-mini", "gpt-4o"],
      credential: { kind: "api_key", secret: "fixture-upstream-key" }, settings: { upstreamBaseUrl: `${upstream.baseUrl}/v1` },
      ...(allMembers ? { allMembers: true } : { memberIds: [adminMemberId] }),
    });
    expect(result.response.status, result.text).toBe(201);
    return record(record(result.body).inferenceProvider);
  };
  const provider = await createProvider(true), providerId = text(provider.id);
  const connected = await api(owner, organization, `/v1/inference-providers/${providerId}/connect`);
  expect(connected.response.status, connected.text).toBe(200);
  const connection = record(record(connected.body).inferenceProvider), key = text(connection.apiKey);
  const models = rows(connection.models);
  const alias = (upstreamModel: string) => text(models.find((model) => model.upstreamModelId === upstreamModel)?.id);
  const definition: GatewayRouterDefinition = { name: "My prompt router", status: "active", minConfidence: 0.8, fallbackRouteId: "writing",
    routes: [ { id: "code", description: "Programming questions", inferenceProviderId: providerId, model: alias("gpt-4o") },
      { id: "writing", description: "Creative writing", inferenceProviderId: providerId, model: alias("gpt-4o-mini") } ] };
  const targets = await api(owner, organization, "/v1/gateway-routers/targets");
  expect(targets.response.status).toBe(200);
  expect(rows(record(targets.body).targets).map((target) => target.model).sort()).toEqual(models.map((model) => model.id).sort());
  const created = await api(owner, organization, "/v1/gateway-routers", "POST", definition);
  expect(created.response.status, created.text).toBe(201);
  const router = record(record(created.body).router), id = text(router.id), path = `/v1/gateway-routers/${id}`;
  expect(id).toMatch(/^gwr_/);
  expect(router.revision).toBe(1);
  expect(record((await api(owner, organization, path)).body).router).toMatchObject(definition);
  const updated = await api(owner, organization, path, "PUT", { ...definition, name: "Edited router", revision: 1 });
  expect(updated.response.status, updated.text).toBe(200);
  expect(record(record(updated.body).router).revision).toBe(2);
  expect((await api(owner, organization, path, "PUT", { ...definition, revision: 1 })).response.status).toBe(409);
  expect(record((await api(owner, organization, path)).body).router).toMatchObject({ name: "Edited router", revision: 2 });
  expect(rows(record((await api(owner, organization, "/v1/gateway-routers")).body).routers)).toHaveLength(1);
  expect(rows(record((await api(other, organization, "/v1/gateway-routers")).body).routers)).toHaveLength(0);
  for (const method of ["GET", "PUT", "DELETE"]) {
    expect((await api(other, organization, path, method, method === "PUT" ? { ...definition, revision: 2 } : undefined)).response.status).toBe(404);
  }
  evidence.recordAssertionEvidence("Member router persistence and isolation", "Member created and reread a router; update advanced revision, stale update failed without overwriting; another member cannot list/read/update/delete it.", true);

  await using gateway = await routerGateway(databaseUrl, upstream.baseUrl);
  const route = async (prompt: string, apiKey = key, stream = false) => {
    const response = await fetch(`${gateway.baseUrl}/api/v1/routers/${id}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: prompt }], stream }), signal: AbortSignal.timeout(30_000),
    });
    return { response, body: await response.text() };
  };
  for (const [prompt, model, selected, fallback, stream] of [
    ["Explain TypeScript generics", "gpt-4o", "code", "none", false],
    ["Write a poem about rain", "gpt-4o-mini", "writing", "none", true],
    ["An uncertain question", "gpt-4o-mini", "writing", "low_confidence", false],
  ] satisfies Array<[string, string, string, string, boolean]>) {
    expect(prompt).not.toMatch(/gwr_|gwm_|ipr_/);
    const before = upstream.requests.length;
    const result = await route(prompt, key, stream);
    expect(result.response.status, result.body).toBe(200);
    expect(result.response.headers.get("x-openwork-router-route-id")).toBe(selected);
    expect(result.response.headers.get("x-openwork-router-revision")).toBe("2");
    expect(result.response.headers.get("x-openwork-router-fallback")).toBe(fallback);
    expect(result.body).toContain("routed answer");
    if (stream) { expect(result.response.headers.get("content-type")).toContain("text/event-stream"); expect(result.body).toContain("[DONE]"); }
    expect(upstream.requests).toHaveLength(before + 1);
    expect(upstream.requests.at(-1)).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer fixture-upstream-key", body: { model, stream, messages: [{ role: "user", content: prompt }] } });
    expect(JSON.stringify(upstream.requests)).not.toContain(key);
  }
  evidence.recordAssertionEvidence("Real aliases route and stream through Gateway", "Deterministic Jev choices selected two distinct upstream models; low confidence used fallback, SSE completed, only the upstream credential reached the provider.", true);
  const otherConnect = await api(other, organization, `/v1/inference-providers/${providerId}/connect`);
  const otherKey = text(record(record(otherConnect.body).inferenceProvider).apiKey);
  const beforeDenied = upstream.requests.length;
  expect((await route("Explain TypeScript", otherKey)).response.status).toBe(404);
  // Same person, distinct real organization/key: the router must not cross tenants.
  const foreignCreated = await api(other, organization, "/v1/org", "POST", { name: "Foreign router organization" });
  expect(foreignCreated.response.ok, foreignCreated.text).toBe(true);
  const foreignOrg = text(record(record(foreignCreated.body).organization).id);
  expect((await api(other, foreignOrg, path)).response.status).toBe(404);
  const foreignProvider = await api(other, foreignOrg, "/v1/inference-providers", "POST", {
    name: "Foreign provider", providerId: "openai", modelIds: ["gpt-4o-mini"], allMembers: true,
    credential: { kind: "api_key", secret: "fixture-upstream-key" }, settings: { upstreamBaseUrl: `${upstream.baseUrl}/v1` },
  });
  expect(foreignProvider.response.status, foreignProvider.text).toBe(201);
  const foreignProviderId = text(record(record(foreignProvider.body).inferenceProvider).id);
  const foreignConnect = await api(other, foreignOrg, `/v1/inference-providers/${foreignProviderId}/connect`);
  expect(foreignConnect.response.status, foreignConnect.text).toBe(200);
  const foreignKey = text(record(record(foreignConnect.body).inferenceProvider).apiKey);
  expect((await route("Write a poem", foreignKey)).response.status).toBe(404);
  const hidden = await createProvider(false);
  const hiddenConnect = await api(den.admin, organization, `/v1/inference-providers/${text(hidden.id)}/connect`);
  expect(hiddenConnect.response.status, hiddenConnect.text).toBe(200);
  const hiddenModel = text(rows(record(record(hiddenConnect.body).inferenceProvider).models)[0]?.id);
  const invalid = { ...definition, routes: definition.routes.map((entry) => ({ ...entry, inferenceProviderId: text(hidden.id), model: hiddenModel })) };
  expect((await api(owner, organization, "/v1/gateway-routers", "POST", invalid)).response.status).toBe(403);
  const grants = rows(provider.accessGrants);
  for (const grant of grants) expect((await api(den.admin, organization, `/v1/inference-providers/${providerId}/access-grants/${text(grant.id)}`, "DELETE")).response.status).toBe(204);
  const revoked = await route("Explain TypeScript");
  expect(revoked.response.status, revoked.body).toBe(403);
  expect(upstream.requests).toHaveLength(beforeDenied);
  const disabled = await api(owner, organization, path, "PUT", { ...definition, status: "disabled", revision: 2 });
  expect(disabled.response.status, disabled.text).toBe(200);
  expect(record(record(disabled.body).router)).toMatchObject({ status: "disabled", revision: 3 });
  expect((await route("Explain TypeScript")).response.status).toBe(404);
  expect((await api(owner, organization, path, "PUT", { ...definition, revision: 3 })).response.status).toBe(403);
  expect((await api(owner, organization, path, "DELETE")).response.status).toBe(204);
  expect((await api(owner, organization, path)).response.status).toBe(404);
  expect((await route("Explain TypeScript")).response.status).toBe(404);
  expect(upstream.requests).toHaveLength(beforeDenied);
  evidence.recordAssertionEvidence("Private ownership and live target revocation fail closed", "Other member and foreign organization keys could not route; inaccessible targets could not be saved; revoked grants denied model dispatch but did not prevent disabling; reactivation without target access was rejected; deleted router no longer routes. All organizations are owned by the disposable scratch database.", true);
});
