export const supportedTargets = ["local/host"];

import { app } from "../../evals/packages/env/src/desktop-app.ts";
import type { App } from "../../evals/packages/env/src/desktop-app.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { createAdmin, createOrg, server } from "../../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../../evals/packages/env/src/den.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { recipe, runRecipe } from "../../evals/packages/env/src/recipe.ts";

/**
 * Local Desktop + Den against a real TrueFoundry gateway, wired the way a
 * customer's provisioning script would do it:
 *
 * 1. An admin creates a custom per-member provider pointing at the gateway.
 * 2. The admin mints an organization API key.
 * 3. A "script" (this file) uses only that API key to push the member's
 *    TrueFoundry key to PUT /v1/llm-providers/:id/member-credentials/:member.
 * 4. The desktop signs in as that member and uses the gateway model.
 *
 * Needs TRUEFOUNDRY_API_KEY (a TrueFoundry PAT or virtual-account token) and
 * optionally TRUEFOUNDRY_BASE_URL (default https://gateway.truefoundry.ai) and
 * TRUEFOUNDRY_MODEL (default: the first model the key can see).
 *
 * Launch: TRUEFOUNDRY_API_KEY=... pnpm world up ./examples/truefoundry-per-member-keys/world.ts
 */

export const TRUEFOUNDRY_WORLD_ORG = "TrueFoundry Per-Member World";
export const TRUEFOUNDRY_WORLD_PROVIDER = "openwork-truefoundry";
export const TRUEFOUNDRY_WORLD_PASSWORD = "OpenWorkEval123!";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function firstModel(baseUrl: string, key: string): Promise<string> {
  const response = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30_000) });
  const body: unknown = await response.json().catch(() => null);
  const data = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const id = data.find((entry) => typeof entry.id === "string")?.id;
  if (!response.ok || typeof id !== "string") throw new Error(`TrueFoundry /models returned ${response.status} with no usable model`);
  return id;
}

export interface TrueFoundryPerMemberWorld {
  den: Den;
  org: DenOrgHandle;
  admin: Awaited<ReturnType<typeof createAdmin>>;
  providerRecordId: string;
  modelId: string;
  baseUrl: string;
  desktop: App;
}

export async function bootTrueFoundryPerMember(
  stack: AsyncDisposableStack,
  place: Place,
  naming?: { stage: string; stageName(base: string): string },
): Promise<TrueFoundryPerMemberWorld> {
  const memberKey = required("TRUEFOUNDRY_API_KEY");
  const baseUrl = (process.env.TRUEFOUNDRY_BASE_URL?.trim() || "https://gateway.truefoundry.ai").replace(/\/+$/, "");
  const modelId = process.env.TRUEFOUNDRY_MODEL?.trim() || await firstModel(baseUrl, memberKey);

  const den = stack.use(await server({ place, provision: false, web: true }));
  const admin = await createAdmin(den, {
    name: "TrueFoundry Admin",
    email: "truefoundry-admin@openwork.test",
    password: TRUEFOUNDRY_WORLD_PASSWORD,
  });
  const org = stack.use(await createOrg(den, naming ? naming.stageName(TRUEFOUNDRY_WORLD_ORG) : TRUEFOUNDRY_WORLD_ORG));
  const asAdmin = { authorization: `Bearer ${admin.token}`, "content-type": "application/json", "x-openwork-org-id": org.id };

  const created = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: asAdmin,
    body: JSON.stringify({
      name: "TrueFoundry Gateway",
      source: "custom",
      customConfig: {
        id: TRUEFOUNDRY_WORLD_PROVIDER,
        name: "TrueFoundry Gateway",
        npm: "@ai-sdk/openai-compatible",
        env: ["TRUEFOUNDRY_API_KEY"],
        api: baseUrl,
        models: [{ id: modelId, name: `${modelId} (TrueFoundry)` }],
      },
      credentialMode: "per_member",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
  });
  const providerRecordId = isRecord(created.body) && isRecord(created.body.llmProvider) && typeof created.body.llmProvider.id === "string"
    ? created.body.llmProvider.id
    : "";
  if (created.response.status !== 201 || !providerRecordId) throw new Error(`Creating the TrueFoundry provider failed: ${created.response.status} ${created.text.slice(0, 300)}`);

  const minted = await denFetch(admin, "/v1/api-keys", { method: "POST", headers: asAdmin, body: JSON.stringify({ name: "TrueFoundry key provisioner" }) });
  const scriptKey = isRecord(minted.body) && typeof minted.body.key === "string" ? minted.body.key : "";
  if (minted.response.status !== 201 || !scriptKey) throw new Error(`Minting the provisioner API key failed: ${minted.response.status}`);

  // From here on, only the API key: this is the customer's provisioning script.
  const asScript = { "x-api-key": scriptKey, "content-type": "application/json", "x-openwork-org-id": org.id };
  const roster = await denFetch(admin, `/v1/llm-providers/${providerRecordId}/member-credentials`, { headers: asScript });
  const bindings = isRecord(roster.body) && Array.isArray(roster.body.memberCredentials) ? roster.body.memberCredentials.filter(isRecord) : [];
  if (!roster.response.ok || bindings.length === 0) throw new Error(`Listing member credentials with the API key failed: ${roster.response.status} ${roster.text.slice(0, 300)}`);
  for (const binding of bindings) {
    if (binding.state !== "missing" || typeof binding.orgMembershipId !== "string") continue;
    const pushed = await denFetch(admin, `/v1/llm-providers/${providerRecordId}/member-credentials/${encodeURIComponent(binding.orgMembershipId)}`, {
      method: "PUT",
      headers: asScript,
      body: JSON.stringify({ apiKey: memberKey, externalCredentialId: "truefoundry-world-pat" }),
    });
    if (!pushed.response.ok) throw new Error(`Pushing the member key with the API key failed: ${pushed.response.status} ${pushed.text.replaceAll(memberKey, "[key]").slice(0, 300)}`);
  }

  const desktop = stack.use(await app({
    den,
    place,
    as: "admin",
    workspacePath: naming ? `/tmp/openwork-truefoundry-world-${naming.stage}` : "/tmp/openwork-truefoundry-world",
    model: `${TRUEFOUNDRY_WORLD_PROVIDER}/${modelId}`,
  }));
  return { den, org, admin, providerRecordId, modelId, baseUrl, desktop };
}

export const truefoundryPerMember = recipe("truefoundry-per-member", async (tools) => {
  const world = await bootTrueFoundryPerMember(tools.stack, tools.place, tools);
  return {
    denWeb: tools.output(world.den.ref.webUrl, { group: "URLs" }),
    denApi: tools.output(world.den.ref.apiUrl, { group: "URLs" }),
    gateway: tools.output(world.baseUrl, { group: "URLs" }),
    cdp: tools.output(world.desktop.handle.cdpUrl, { group: "URLs" }),
    adminEmail: tools.output("truefoundry-admin@openwork.test", { group: "Accounts" }),
    adminPassword: tools.secret(TRUEFOUNDRY_WORLD_PASSWORD, { group: "Accounts" }),
    providerId: tools.output(TRUEFOUNDRY_WORLD_PROVIDER, { group: "Provider" }),
    modelId: tools.output(world.modelId, { group: "Provider" }),
    providerRecordId: tools.output(world.providerRecordId, { group: "Provider" }),
  };
});

export default truefoundryPerMember;

if (import.meta.main) await runRecipe(truefoundryPerMember);
