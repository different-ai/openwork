import { APICallError } from "@ai-sdk/provider";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE } from "@openwork/types/den/gateway-usage-limits";
import { OPENWORK_MODELS_ALLOWANCE_MESSAGE, openWorkModelsAllowanceErrorBody } from "@openwork/types/den/inference";
import { gatewayBase, GATEWAY_QUOTA_MESSAGE, isGatewayQuotaResponse, isOpenWorkModelsAllowanceResponse, openWorkModelsBase, record } from "../gateway-quota.js";

type Fetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

/**
 * Usage limits that last until a window resets are not rate limits: the AI SDK marks every 429 retryable, so the
 * engine would retry them for about a minute. Answer them once, as a non-retryable error the app can classify.
 */
function noRetryFetch(base: URL, matches: (base: URL, url: URL, response: Response) => Promise<boolean>, error: (url: URL, response: Response) => APICallError): Fetch {
  return async (input, init) => {
    const response = await globalThis.fetch(input, init);
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!await matches(base, url, response)) return response;
    void response.body?.cancel().catch(() => undefined);
    throw error(url, response);
  };
}

export const OpenWorkGatewayQuota = async () => ({
  config: async (config: { provider?: Record<string, unknown> }) => {
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      if (!record(provider)) continue;
      const models = openWorkModelsBase(id, record(provider.options) ? provider.options.baseURL ?? provider.api : provider.api);
      if (models) {
        const options = record(provider.options) ? provider.options : {};
        if (options.fetch !== undefined) continue;
        options.fetch = noRetryFetch(models, isOpenWorkModelsAllowanceResponse, (url, response) => new APICallError({
          message: OPENWORK_MODELS_ALLOWANCE_MESSAGE,
          url: `${url.origin}${url.pathname}`,
          requestBodyValues: undefined,
          statusCode: response.status,
          responseHeaders: Object.fromEntries(response.headers),
          responseBody: JSON.stringify(openWorkModelsAllowanceErrorBody()),
          isRetryable: false,
        }));
        provider.options = options;
        continue;
      }
      if (!record(provider.options)) continue;
      const options = provider.options;
      const base = gatewayBase(id, options.baseURL);
      if (!base || options.fetch !== undefined) continue;
      options.fetch = noRetryFetch(base, isGatewayQuotaResponse, (url, response) => new APICallError({
        message: GATEWAY_QUOTA_MESSAGE,
        url: `${url.origin}${url.pathname}`,
        requestBodyValues: undefined,
        statusCode: response.status,
        responseHeaders: Object.fromEntries(response.headers),
        responseBody: JSON.stringify({ error: {
          type: "usage_limit_error",
          code: GATEWAY_USAGE_LIMIT_ERROR_CODE,
          source: "openwork_gateway",
          message: GATEWAY_QUOTA_MESSAGE,
        } }),
        isRetryable: false,
      }));
    }
  },
});
