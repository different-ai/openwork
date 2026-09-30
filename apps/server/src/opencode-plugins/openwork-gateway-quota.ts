import { APICallError } from "@ai-sdk/provider";
import { GATEWAY_USAGE_LIMIT_ERROR_CODE } from "@openwork/types/den/gateway-usage-limits";
import { gatewayBase, GATEWAY_QUOTA_MESSAGE, isGatewayQuotaResponse, record } from "../gateway-quota.js";

export const OpenWorkGatewayQuota = async () => ({
  config: async (config: { provider?: Record<string, unknown> }) => {
    for (const [id, provider] of Object.entries(config.provider ?? {})) {
      if (!record(provider) || !record(provider.options)) continue;
      const options = provider.options;
      const base = gatewayBase(id, options.baseURL);
      if (!base || options.fetch !== undefined) continue;
      options.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        const response = await globalThis.fetch(input, init);
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (!await isGatewayQuotaResponse(base, url, response)) return response;
        void response.body?.cancel().catch(() => undefined);
        throw new APICallError({
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
        });
      };
    }
  },
});
