import type { Seed } from "@openwork/env";
import { isRecord } from "./library.ts";

/**
 * An organization member who signs in on a managed desktop before creating
 * any workspace, with one organization LLM provider assigned to them. The
 * installation carries a Den bootstrap, so the desktop does not create its
 * public first-launch folder: the member really has zero workspaces.
 */
export async function providersBeforeFirstWorkspace(seed: Seed) {
  const organizationName = `Providers before workspace ${Date.now()}`;
  const providerName = "Pilot inference";
  const den = await seed.den({
    org: {
      name: organizationName,
      admin: { name: "Pilot Admin" },
      members: { member: { name: "Pilot Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("seed.den() did not provision the pilot member session");

  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: providerName,
      source: "custom",
      customConfig: {
        id: "pilot-inference",
        name: providerName,
        npm: "@ai-sdk/openai-compatible",
        api: "https://inference.eval.invalid/v1",
        env: ["PILOT_INFERENCE_API_KEY"],
        models: [{ id: "pilot-model", name: "Pilot model" }],
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
    providerName,
    providerId: llmProvider.id,
    firstWorkspacePath: seed.tmpPath("first-workspace"),
  };
}
