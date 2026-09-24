import { ANONYMOUS_INFERENCE_MODEL_ID, ANONYMOUS_INFERENCE_PROVIDER_NAME, LOCAL_ROUTE_PREFIX } from "./settings.js";
import { isRecord } from "./http.js";

/** The engine-facing provider entry this service owns in the runtime OpenCode config. */
function generatedModel(id = ANONYMOUS_INFERENCE_MODEL_ID) {
  return {
    id, name: "GPT-5.6 Luna", attachment: false, reasoning: false, temperature: false, tool_call: true,
    options: { reasoningEffort: "none" },
    limit: { context: 135_168, input: 131_072, output: 4_096 },
    modalities: { input: ["text"], output: ["text"] },
  };
}
function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
export function ownedProvider(localAccessToken: string, boundPort: number) {
  return {
    name: ANONYMOUS_INFERENCE_PROVIDER_NAME, npm: "@ai-sdk/openai-compatible",
    options: { apiKey: localAccessToken, baseURL: `http://127.0.0.1:${boundPort}${LOCAL_ROUTE_PREFIX}` },
    models: { [ANONYMOUS_INFERENCE_MODEL_ID]: generatedModel() },
  };
}
/** True only for an entry exactly as `ownedProvider` writes it; anything the user edited is left alone. */
export function isOwnedProvider(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["name", "npm", "options", "models"])
    || value.name !== ANONYMOUS_INFERENCE_PROVIDER_NAME || value.npm !== "@ai-sdk/openai-compatible"
    || !isRecord(value.options) || !hasExactKeys(value.options, ["apiKey", "baseURL"])
    || typeof value.options.apiKey !== "string" || !/^owf_local_[A-Za-z0-9_-]{43}$/.test(value.options.apiKey)
    || typeof value.options.baseURL !== "string" || !/^http:\/\/127\.0\.0\.1:\d+\/anonymous-inference\/v1$/.test(value.options.baseURL)
    || !isRecord(value.models) || Object.keys(value.models).length !== 1) return false;
  const model = value.models[ANONYMOUS_INFERENCE_MODEL_ID];
  if (!isRecord(model) || !hasExactKeys(model, Object.keys(generatedModel()))) return false;
  return Object.entries(generatedModel()).every(([key, expected]) => JSON.stringify(model[key]) === JSON.stringify(expected));
}
