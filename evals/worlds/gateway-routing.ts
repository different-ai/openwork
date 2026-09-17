import type { Seed } from "@openwork/env";
import { api, orgId, record, rows, text } from "./gateway-router.ts";

/** Browser CRUD only: a real member, real API and disposable DB, no inference. */
export async function memberRoutingWeb(seed: Seed) {
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new Error("Routing browser fixture refuses an attached Den; use runner-owned isolated resources");
  }
  const name = `Routing browser ${Date.now()}`;
  const den = await seed.den({
    env: { GATEWAY_ENABLED: "true", GATEWAY_PUBLIC_BASE_URL: "http://127.0.0.1:19999", GATEWAY_PROXY_BASE_URL: "http://127.0.0.1:19999" },
    org: { name, admin: { name: "Routing Admin" }, members: { author: { name: "Routing Member" } } },
  });
  // Never arrange providers on a reused or shared organization.
  const scratchDatabase = den.database?.url && new URL(den.database.url).pathname.startsWith("/openwork_eval_");
  const isolatedSandbox = den.placement?.kind === "daytona" && Boolean(den.placement.sandboxId);
  if (!scratchDatabase && !isolatedSandbox) {
    throw new Error("Routing browser fixture requires an owned scratch database or isolated sandbox; refusing organization mutation");
  }
  const organization = await orgId(den.admin, name);
  const author = den.members.author;
  if (!author) throw new Error("Missing routing author");
  const created = await api(den.admin, organization, "/v1/inference-providers", "POST", {
    name: "Browser model provider", providerId: "openai", modelIds: ["gpt-4o-mini", "gpt-4o"],
    allMembers: true, credential: { kind: "api_key", secret: "fixture-not-a-provider-key" },
  });
  if (created.response.status !== 201) throw new Error(`Provider setup failed: ${created.response.status} ${created.text}`);
  const providerId = text(record(record(created.body).inferenceProvider).id);
  const result = await api(author, organization, "/v1/gateway-routers/targets");
  if (!result.response.ok) throw new Error(`Target setup failed: ${result.response.status}`);
  const targets = rows(record(result.body).targets).filter(target => target.inferenceProviderId === providerId);
  if (targets.length !== 2) throw new Error("Expected exactly two member-accessible models");
  const web = await seed.web({ den, signedInAs: author, startPath: "/dashboard/gateway-routing", headless: true,
    viewport: { width: 1440, height: 1100, deviceScaleFactor: 1 } });
  return {
    den, web,
    modelLabels: targets.map(target => `${text(target.name)} · ${text(target.providerName)}`),
    async revokeModelAccess() {
      for (const grant of rows(record(record(created.body).inferenceProvider).accessGrants)) {
        const revoked = await api(den.admin, organization, `/v1/inference-providers/${providerId}/access-grants/${text(grant.id)}`, "DELETE");
        if (revoked.response.status !== 204) throw new Error(`Grant revocation failed: ${revoked.response.status}`);
      }
    },
    async savedRouters() {
      const response = await api(author, organization, "/v1/gateway-routers");
      if (!response.response.ok) throw new Error(`Read routers failed: ${response.response.status}`);
      return rows(record(response.body).routers);
    },
  };
}
