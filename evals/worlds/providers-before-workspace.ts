import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

type OrganizationProviderOptions = {
  label: string;
  providerName: string;
  modelName: string;
  /** Deterministic model witness the organization provider points at. */
  mock?: ReturnType<Seed["mock"]>;
};

async function signedInBeforeFirstWorkspace(seed: Seed, options: OrganizationProviderOptions) {
  const organizationName = `${options.label} ${Date.now()}`;
  const den = await seed.den({
    org: {
      name: organizationName,
      admin: { name: "Pilot Admin" },
      members: { member: { name: "Pilot Member" } },
    },
    ...(options.mock ? { mocks: { agent: options.mock } } : {}),
  });
  const member = den.members.member;
  if (!member) throw new Error("seed.den() did not provision the pilot member session");
  const agent = options.mock ? den.mocks.agent : undefined;
  if (options.mock && !agent) throw new Error("seed.den() did not boot the model witness");

  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: options.providerName,
      source: "custom",
      customConfig: {
        id: "pilot-inference",
        name: options.providerName,
        npm: "@ai-sdk/openai-compatible",
        api: agent ? `${agent.url}/v1` : "https://inference.eval.invalid/v1",
        env: ["PILOT_INFERENCE_API_KEY"],
        models: [{ id: "pilot-model", name: options.modelName }],
      },
      apiKey: "sk-pilot-inference-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const llmProvider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (created.response.status !== 201 || typeof llmProvider?.id !== "string") {
    throw new Error(`Organization provider setup failed: HTTP ${created.response.status}`);
  }

  const app = await seed.desktop({ den, as: "member", workspace: false, name: "providers-before-workspace" });
  return {
    den,
    member,
    app,
    organizationName,
    providerName: options.providerName,
    modelName: options.modelName,
    providerId: llmProvider.id,
    firstWorkspacePath: seed.tmpPath("first-workspace"),
  };
}

/**
 * An organization member who signs in on a managed desktop before creating
 * any workspace, with one organization LLM provider assigned to them. The
 * installation carries a Den bootstrap, so the desktop does not create its
 * public first-launch folder: the member really has zero workspaces.
 */
export async function providersBeforeFirstWorkspace(seed: Seed) {
  return signedInBeforeFirstWorkspace(seed, {
    label: "Providers before workspace",
    providerName: "Pilot inference",
    modelName: "Pilot model",
  });
}

export const ORGANIZATION_MODEL_REPLY = "ORG-MODEL-FIRST-MESSAGE-REPLY-OK";

/**
 * The same member, but the organization provider serves a deterministic model
 * that answers any prompt, so the first message typed before any workspace
 * exists can be answered end to end.
 */
export async function organizationModelBeforeFirstWorkspace(seed: Seed) {
  const mock = seed.mock({ agentWorkloads: [{ promptMarker: "hello", matchAll: true, finalReply: ORGANIZATION_MODEL_REPLY, steps: [] }] });
  const world = await signedInBeforeFirstWorkspace(seed, {
    label: "Organization model before workspace",
    providerName: "Pilot inference",
    modelName: "Pilot model",
    mock,
  });
  return { ...world, reply: ORGANIZATION_MODEL_REPLY };
}
