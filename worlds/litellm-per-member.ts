import { app } from "../evals/packages/env/src/desktop-app.ts";
import type { App } from "../evals/packages/env/src/desktop-app.ts";
import { createAdmin, createOrg, inviteMember, server } from "../evals/packages/env/src/den.ts";
import type { Den, DenOrgHandle } from "../evals/packages/env/src/den.ts";
import { liteLlmPerMemberProvider } from "../evals/packages/env/src/litellm-provider.ts";
import { liteLlm } from "../evals/packages/env/src/litellm.ts";
import type { LiteLlmHandle } from "../evals/packages/env/src/litellm.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";

export const LITELLM_WORLD_ORG = "LiteLLM Per-Member World";
export const LITELLM_WORLD_PROVIDER = "openwork-litellm-per-member";
export const LITELLM_WORLD_MODEL = "openwork-litellm-per-member-model";
export const LITELLM_WORLD_PASSWORD = "OpenWorkEval123!";

const REPLY = "The database-backed per-member LiteLLM world is working.";

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
 * Launch: `pnpm world up ./worlds/litellm-per-member.ts`
 */
export async function bootLiteLlmPerMember(
  stack: AsyncDisposableStack,
  place: Place,
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
  const org = stack.use(await createOrg(den, LITELLM_WORLD_ORG));
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
    workspacePath: "/tmp/openwork-litellm-per-member-world",
    model: `${LITELLM_WORLD_PROVIDER}/${LITELLM_WORLD_MODEL}`,
  }));
  return { gateway, den, org, admin, alice, provider, desktop };
}

async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const place = resolvePlace();
  const { gateway, den, desktop } = await bootLiteLlmPerMember(stack, place);
  await hold({
    outputs: {
      denWeb: den.ref.webUrl,
      denApi: den.ref.apiUrl,
      litellm: gateway.baseUrl,
      cdp: desktop.handle.cdpUrl,
    },
  });
}

if (import.meta.main) {
  await main();
}
