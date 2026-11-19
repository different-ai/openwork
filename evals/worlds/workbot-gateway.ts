import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { allocateFreePort } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { modelProbeFixture } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("Expected a Den response identity");
  return value;
}

/** Real Den, public provider/grant writes, real legacy runner; only outside inference is local. */
export async function workbotGateway(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const runner = await modelProbeFixture({ protocol: "openai-responses", lunaAvailable: false });
    resources.defer(() => runner.close());
    const keys = { openai: randomBytes(24).toString("hex"), anthropic: randomBytes(24).toString("hex") };
    const upstreamCalls: { path: string; authorized: boolean }[] = [];
    const upstream = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume a possible completion body */ }
      const authorized = request.headers.authorization === `Bearer ${keys.openai}` || request.headers["x-api-key"] === keys.anthropic;
      upstreamCalls.push({ path: request.url ?? "", authorized });
      response.setHeader("content-type", "application/json");
      // Discovery/save must never need a paid request. Any unexpected inference fails visibly.
      response.writeHead(503).end(JSON.stringify({ error: "fixture_inference_not_expected" }));
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    resources.defer(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Missing local upstream listener");
    const upstreamUrl = `http://127.0.0.1:${address.port}`;
    const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
    const den = await seed.den({
      org: { name: "Gateway model workspace", admin: { name: "Workspace Owner" }, members: { restricted: { name: "Restricted Model Manager" } } },
      env: {
        DEN_HEADLESS_RUNNER_URL: runner.url, DEN_HEADLESS_RUNNER_TOKEN: "r".repeat(32),
        GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
        GATEWAY_EGRESS_ALLOWED_ORIGINS: upstreamUrl,
      },
    });
    const context = record((await seed.api(den.admin, "/v1/org")).body);
    const organizationId = text(record(context.organization).id);
    const members = Array.isArray(context.members) ? context.members.map(record) : [];
    const memberId = (email: string) => text(members.find(member => record(member.user).email === email)?.id);
    const ownerId = memberId(den.admin.email);
    const restricted = den.members.restricted;
    if (!restricted) throw new Error("Missing restricted member");
    const scope = { "x-openwork-org-id": organizationId };
    async function write(path: string, method: string, body: unknown) {
      const result = await seed.api(den.admin, path, { method, headers: scope, body: JSON.stringify(body) });
      if (!result.response.ok) throw new Error(`Fixture setup ${method} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
      return record(result.body);
    }
    await write(`/v1/admin/organizations/${organizationId}/capabilities`, "PUT", { capabilities: { workbot: true, permissions: true } });
    const team = record((await write("/v1/teams", "POST", { name: "Restricted model managers", memberIds: [memberId(restricted.email)] })).team);
    await write("/v1/permissions/sets", "POST", { teamId: text(team.id), permissions: [{ key: "inference.manage", status: "allow" }] });
    async function provider(providerId: "openai" | "anthropic", modelId: string, allMembers: boolean) {
      const result = await write("/v1/inference-providers", "POST", {
        name: `Fixture ${providerId}`, providerId, modelIds: [modelId],
        settings: { upstreamBaseUrl: `${upstreamUrl}/${providerId}/v1` },
        credential: { kind: "api_key", secret: keys[providerId] },
        ...(allMembers ? { allMembers: true } : { memberIds: [ownerId] }),
      });
      const summary = record(result.inferenceProvider);
      const models = Array.isArray(summary.models) ? summary.models.map(record) : [];
      const model = models.find(item => item.upstreamModelId === modelId);
      if (!model) throw new Error(`Configured ${providerId} model was not usable by its owner`);
      return { id: text(model.id), name: text(model.name), upstreamId: modelId };
    }
    const openai = await provider("openai", "gpt-4o-mini", true);
    const anthropic = await provider("anthropic", "claude-sonnet-4-5-20250929", false);
    const viewport = { width: 1280, height: 800, deviceScaleFactor: 1 };
    const settingsUrl = `${den.ref.webUrl}/dashboard/workbot-settings`;
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: restricted, startPath: "/dashboard/workbot-settings", headless: true, viewport });
    return {
      web, member, admin: den.admin, restricted, scope, openai, anthropic, settingsUrl,
      completionCount: () => runner.calls().length + upstreamCalls.length,
      secretsAbsent: (value: string) => Object.values(keys).every(key => !value.includes(key)) && !value.includes("fixture-model-key") && !value.includes("ow_gw_"),
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
