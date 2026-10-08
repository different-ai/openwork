import { ANONYMOUS_INFERENCE_MODEL_ID, ANONYMOUS_INFERENCE_PROVIDER_NAME, LOCAL_ROUTE_PREFIX } from "./settings.js";
import { isRecord } from "./http.js";

/** The engine-facing provider entry this service owns in the runtime OpenCode config. */
/** The model's own limits, as with paid Models; the Gateway does not cap Auto's context or output. */
const AUTO_LIMIT = { context: 1_050_000, input: 922_000, output: 128_000 };
/** Written by earlier builds; still ours, and rewritten to the current shape on the next start. */
const PREVIOUS_AUTO_LIMIT = { context: 135_168, input: 131_072, output: 4_096 };
function generatedModel(id = ANONYMOUS_INFERENCE_MODEL_ID, limit = AUTO_LIMIT, images = true) {
  return {
    id, name: "GPT-6 Luna", attachment: images, reasoning: false, temperature: false, tool_call: true,
    options: { reasoningEffort: "none", store: false },
    limit,
    modalities: { input: images ? ["text", "image"] : ["text"], output: ["text"] },
  };
}
function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function ownedProvider(localAccessToken: string, boundPort: number) {
  return {
    name: ANONYMOUS_INFERENCE_PROVIDER_NAME, npm: "@ai-sdk/openai",
    options: { apiKey: localAccessToken, baseURL: `http://127.0.0.1:${boundPort}${LOCAL_ROUTE_PREFIX}` },
    models: { [ANONYMOUS_INFERENCE_MODEL_ID]: generatedModel() },
  };
}
/** True only for an entry exactly as `ownedProvider` writes it; anything the user edited is left alone. */
export function isOwnedProvider(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "npm", "options", "models"])
    || value.name !== ANONYMOUS_INFERENCE_PROVIDER_NAME || (value.npm !== "@ai-sdk/openai" && value.npm !== "@ai-sdk/openai-compatible")
    || !isRecord(value.options) || !hasExactKeys(value.options, ["apiKey", "baseURL"])
    || typeof value.options.apiKey !== "string" || !/^owf_local_[A-Za-z0-9_-]{43}$/.test(value.options.apiKey)
    || typeof value.options.baseURL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/anonymous-inference\/v1$/.test(value.options.baseURL)
    || !isRecord(value.models) || Object.keys(value.models).length !== 1) return false;
  // Recognize our previous generated config only so startup can replace its adapter and model.
  const previousAdapter = value.npm === "@ai-sdk/openai-compatible";
  const id = previousAdapter ? "openai/gpt-5.6-luna" : ANONYMOUS_INFERENCE_MODEL_ID;
  const model = value.models[id];
  if (!isRecord(model) || !hasExactKeys(model, Object.keys(generatedModel()))) return false;
  // Earlier builds wrote a text-only model; recognize it so the next start rewrites it.
  return [AUTO_LIMIT, PREVIOUS_AUTO_LIMIT].some((limit) => [true, false].some((images) => {
    const generated = generatedModel(id, limit, images);
    const expected = previousAdapter ? { ...generated, name: "GPT-5.6 Luna", options: { reasoningEffort: "none" } } : generated;
    return Object.entries(expected).every(([key, value]) => JSON.stringify(model[key]) === JSON.stringify(value));
  }));
}
