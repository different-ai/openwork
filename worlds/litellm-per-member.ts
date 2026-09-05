import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { denFetch } from "../evals/packages/behaviors/src/den.ts";
import { createAdmin, createOrg, inviteMember, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { liteLlmPerMemberProvider } from "../evals/packages/env/src/litellm-provider.ts";
import { liteLlm } from "../evals/packages/env/src/litellm.ts";
import type { LiteLlmHandle } from "../evals/packages/env/src/litellm.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { recipe, runRecipe } from "../evals/packages/env/src/recipe.ts";

export const LITELLM_WORLD_ORG = "LiteLLM Per-Member World";
export const LITELLM_WORLD_PROVIDER = "openwork-litellm-per-member";
export const LITELLM_WORLD_MODEL = "openwork-litellm-per-member-model";
export const LITELLM_WORLD_PASSWORD = "OpenWorkEval123!";

const REPLY = "The database-backed per-member LiteLLM world is working.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface LiteLlmPerMemberWorld {
  gateway: LiteLlmHandle;
  den: Den;
  org: DenOrgHandle;
  admin: Awaited<ReturnType<typeof createAdmin>>;
  alice: Awaited<ReturnType<typeof inviteMember>>;
  provider: Awaited<ReturnType<typeof liteLlmPerMemberProvider>>;
  desktop: App;
}

/**
 * Local Desktop + Den + database-backed LiteLLM world for manually exercising
 * the complete per-member example. The LiteLLM gateway talks to a deterministic
 * local OpenAI-compatible witness; it never reads or requires OPENAI_API_KEY.
 *
 * Launch: `pnpm world up litellm-per-member [--stage <s>]`
 */
export async function bootLiteLlmPerMember(
  stack: AsyncDisposableStack,
  place: Place,
  naming?: { stage: string; stageName(base: string): string },
): Promise<LiteLlmPerMemberWorld> {
  const gateway = stack.use(await liteLlm({
    place,
    modelId: LITELLM_WORLD_MODEL,
    reply: REPLY,
    database: true,
    maxInputTokens: 128_000,
    maxOutputTokens: 16_384,
  }));
  const den = stack.use(await server({ place, provision: false, web: true }));
  const admin = await createAdmin(den, {
    name: "LiteLLM Admin",
    email: "litellm-admin@openwork.test",
    password: LITELLM_WORLD_PASSWORD,
  });
  const org = stack.use(await createOrg(
    den,
    naming ? naming.stageName(LITELLM_WORLD_ORG) : LITELLM_WORLD_ORG,
  ));
  const alice = await inviteMember(den, "alice", {
    name: "Alice LiteLLM",
    email: "alice-litellm@openwork.test",
    password: LITELLM_WORLD_PASSWORD,
  });
  const provider = await liteLlmPerMemberProvider(admin, {
    gateway,
    orgId: org.id,
    providerId: LITELLM_WORLD_PROVIDER,
    name: "Per-Member LiteLLM Gateway",
    envVar: "LITELLM_PER_MEMBER_API_KEY",
    modelId: LITELLM_WORLD_MODEL,
    modelName: "Per-Member LiteLLM Witness",
  });
  const desktop = stack.use(await app({
    den,
    place,
    as: "admin",
    workspacePath: naming
      ? `/tmp/openwork-litellm-per-member-world-${naming.stage}`
      : "/tmp/openwork-litellm-per-member-world",
    model: `${LITELLM_WORLD_PROVIDER}/${LITELLM_WORLD_MODEL}`,
  }));
  return { gateway, den, org, admin, alice, provider, desktop };
}

export const litellmPerMember = recipe("litellm-per-member", async (tools) => {
  const world = await bootLiteLlmPerMember(tools.stack, tools.place, tools);
  let aliceKey = tools.output("unavailable", { group: "Keys", note: "member key was not requested" });
  try {
    const connected = await denFetch(
      world.alice,
      `/v1/llm-providers/${encodeURIComponent(world.provider.providerRecordId)}/connect`,
      { headers: { authorization: `Bearer ${world.alice.token}` } },
    );
    if (!connected.response.ok) {
      throw new Error(`LiteLLM member connect failed (${connected.response.status}): ${connected.text}`);
    }
    const connectedProvider = isRecord(connected.body) && isRecord(connected.body.llmProvider)
      ? connected.body.llmProvider
      : null;
    const memberKey = connectedProvider && typeof connectedProvider.apiKey === "string"
      ? connectedProvider.apiKey
      : null;
    if (memberKey === null) throw new Error("LiteLLM member connect response did not include an API key");
    aliceKey = tools.secret(memberKey, { group: "Keys", note: "per-member virtual key (Den connect)" });
  } catch (error) {
    aliceKey = tools.output("unavailable", { group: "Keys", note: messageText(error) });
  }
  return {
    denWeb: tools.output(world.den.ref.webUrl, { group: "URLs" }),
    denApi: tools.output(world.den.ref.apiUrl, { group: "URLs" }),
    litellm: tools.output(world.gateway.baseUrl, { group: "URLs" }),
    cdp: tools.output(world.desktop.handle.cdpUrl, { group: "URLs" }),
    adminEmail: tools.output("litellm-admin@openwork.test", { group: "Accounts" }),
    adminPassword: tools.secret(LITELLM_WORLD_PASSWORD, { group: "Accounts" }),
    aliceEmail: tools.output("alice-litellm@openwork.test", { group: "Accounts" }),
    alicePassword: tools.secret(LITELLM_WORLD_PASSWORD, { group: "Accounts" }),
    litellmMasterKey: tools.secret(world.gateway.apiKey, { group: "Keys", note: "LiteLLM admin key" }),
    litellmUpstreamKey: tools.secret(world.gateway.upstreamKey, { group: "Keys", note: "witness upstream key" }),
    aliceKey,
    providerId: tools.output(LITELLM_WORLD_PROVIDER, { group: "Provider" }),
    modelId: tools.output(LITELLM_WORLD_MODEL, { group: "Provider" }),
    providerRecordId: tools.output(world.provider.providerRecordId, { group: "Provider" }),
  };
});

export default litellmPerMember;

if (import.meta.main) await runRecipe(litellmPerMember);
