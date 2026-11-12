import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/** A Persian turn and an English turn; only the model is synthetic. */
export const persianPrompt = "این یک پرسش فارسی است RTL-PERSIAN-PROMPT";
export const persianReply = "**پاسخ فارسی** همراه با یک جمله انگلیسی.";
export const persianReplyText = "پاسخ فارسی همراه با یک جمله انگلیسی.";

export const englishPrompt = "An English prompt RTL-ENGLISH-PROMPT";
export const englishReply = "**English reply** next to a Persian جمله.";
export const englishReplyText = "English reply next to a Persian جمله.";

/** Opens with an English word, but the sentence is overwhelmingly Persian. */
export const mixedPrompt = "OpenWork یک برنامه است و من یک پرسش فارسی مینویسم RTLMIX";
export const mixedReply = "**OpenWork** یک برنامه agent است و بیشتر متن این پاسخ فارسی است.";
export const mixedReplyText = "OpenWork یک برنامه agent است و بیشتر متن این پاسخ فارسی است.";

/**
 * A signed-in app-web chat with a deterministic model: one Persian turn, one
 * English turn and one that opens with an English word but is mostly Persian.
 * The composer and the answers must each follow the direction of their text.
 */
export async function rtlTextDirection(seed: Seed) {
  const providerId = "rtl-text-direction-mock";
  const modelId = "rtl-text-direction-model";
  const mock = seed.mock({
    agentWorkloads: [
      { promptMarker: "RTL-PERSIAN-PROMPT", latestUserTurn: true, finalReply: persianReply, steps: [] },
      { promptMarker: "RTL-ENGLISH-PROMPT", latestUserTurn: true, finalReply: englishReply, steps: [] },
      { promptMarker: "RTLMIX", latestUserTurn: true, finalReply: mixedReply, steps: [] },
    ],
  });
  const { den, webPort } = await denForAppWeb(seed, {
    mocks: { agent: mock },
    org: { name: "Acme", admin: { name: "Avery Owner" } },
  });
  const witness = den.mocks.agent;
  if (!witness) throw new Error("The Den did not boot its RTL model.");
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, as: "admin", name: "rtl-text-direction", workspacePath: seed.tmpPath("rtl-text-direction"),
  });
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, { provider: {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "RTL text direction mock",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-rtl-text-direction" },
      models: { [modelId]: { name: "RTL text direction model" } },
    },
  } });
  await seed.session(app, { title: "RTL text direction" });
  return { app, workspace };
}
