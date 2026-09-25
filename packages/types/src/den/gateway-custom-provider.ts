/**
 * Catalog id reserved for an organization's own OpenAI-compatible endpoint.
 * Its models and endpoint come from the saved provider, not from models.dev.
 */
export const CUSTOM_GATEWAY_PROVIDER_ID = "openwork-custom";
export const CUSTOM_GATEWAY_PROVIDER_NPM = "@ai-sdk/openai-compatible";
export const CUSTOM_GATEWAY_PROVIDER_ENV = ["CUSTOM_PROVIDER_API_KEY"] as const;
