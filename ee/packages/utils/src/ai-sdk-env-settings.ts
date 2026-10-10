/**
 * The constructor option each bundled AI SDK provider package fills from an
 * environment variable when that option is not passed, e.g. `@ai-sdk/amazon-bedrock`
 * calls `loadSetting({ settingValue: options.region, environmentVariableName: "AWS_REGION" })`.
 *
 * These pairs are hard-coded inside the SDK copies bundled in the pinned
 * OpenCode engine and are not exported, so they are listed here.
 * `evals/specs/ai-sdk-env-settings-drift.test.ts` extracts every pair from the
 * pinned engine binary and fails when this list no longer matches it: update
 * it whenever `constants.json` moves `opencodeVersion`.
 */
export const aiSdkEnvSettings = {
  AI_GATEWAY_API_KEY: "apiKey",
  ALIBABA_API_KEY: "apiKey",
  ANTHROPIC_API_KEY: "apiKey",
  ANTHROPIC_BASE_URL: "baseURL",
  AWS_ACCESS_KEY_ID: "accessKeyId",
  AWS_BEARER_TOKEN_BEDROCK: "apiKey",
  AWS_REGION: "region",
  AWS_SECRET_ACCESS_KEY: "secretAccessKey",
  AWS_SESSION_TOKEN: "sessionToken",
  AZURE_API_KEY: "apiKey",
  AZURE_RESOURCE_NAME: "resourceName",
  CEREBRAS_API_KEY: "apiKey",
  COHERE_API_KEY: "apiKey",
  DEEPINFRA_API_KEY: "apiKey",
  GITLAB_TOKEN: "apiKey",
  GOOGLE_GENERATIVE_AI_API_KEY: "apiKey",
  GOOGLE_VERTEX_API_KEY: "apiKey",
  GOOGLE_VERTEX_LOCATION: "location",
  GOOGLE_VERTEX_PROJECT: "project",
  GROQ_API_KEY: "apiKey",
  MISTRAL_API_KEY: "apiKey",
  OPENAI_API_KEY: "apiKey",
  OPENAI_BASE_URL: "baseURL",
  OPENROUTER_API_KEY: "apiKey",
  PERPLEXITY_API_KEY: "apiKey",
  VENICE_API_KEY: "apiKey",
  VERCEL_API_KEY: "apiKey",
  XAI_API_KEY: "apiKey",
} as const satisfies Record<string, string>

const settingByEnvName: ReadonlyMap<string, string> = new Map(Object.entries(aiSdkEnvSettings))

/** The SDK option `envName` feeds, or null when no bundled SDK reads it. */
export function aiSdkEnvSetting(envName: string): string | null {
  return settingByEnvName.get(envName) ?? null
}
