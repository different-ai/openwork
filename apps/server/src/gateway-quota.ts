import {
  GATEWAY_USAGE_LIMIT_ERROR_CODE,
  hasGatewayUsageLimitHttpMarker,
} from "@openwork/types/den/gateway-usage-limits";

export const GATEWAY_QUOTA_MESSAGE = "You have reached your AI Gateway usage limit.";
const MAX_ERROR_BYTES = 16_384;
const BODY_TIMEOUT_MS = 5_000;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function gatewayBase(id: string, baseURL: unknown): URL | undefined {
  if (!/^ipr_[a-z0-9]+$/.test(id) || typeof baseURL !== "string") return;
  try {
    const url = new URL(baseURL);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (!url.pathname.endsWith(`/api/v1/providers/${id}`)) return;
    return url;
  } catch {
    return;
  }
}

export async function isGatewayQuotaResponse(base: URL, url: URL, response: Response): Promise<boolean> {
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)
    || (response.url && new URL(response.url).origin !== base.origin)
    || !hasGatewayUsageLimitHttpMarker(response)) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), BODY_TIMEOUT_MS);
  });
  const read = async () => {
    let size = 0;
    let text = "";
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_ERROR_BYTES) return false;
      text += decoder.decode(chunk.value, { stream: true });
    }
    const body: unknown = JSON.parse(text + decoder.decode());
    return record(body) && record(body.error)
      && body.error.code === GATEWAY_USAGE_LIMIT_ERROR_CODE
      && body.error.source === "openwork_gateway"
      && body.error.type === "usage_limit_error"
      && body.error.message === GATEWAY_QUOTA_MESSAGE;
  };
  try {
    return await Promise.race([read(), expired]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
  }
}
