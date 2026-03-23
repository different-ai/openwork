import { storeBundleJson } from "../../../../server/_lib/blob-store.ts";
import { buildCorsHeaders, rateLimitPublishRequest, validateTrustedOrigin, verifyShareBotProtection } from "../../../../server/_lib/publish-security.ts";
import { buildBundleUrls, getEnv, validateBundlePayload } from "../../../../server/_lib/share-utils.ts";
import { buildRequestLike } from "../../../../server/_lib/request-like.ts";

export const runtime = "nodejs";

function formatPublishError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Blob put failed";
  if (message.includes("BLOB_READ_WRITE_TOKEN") || message.includes("No token found")) {
    return "Publishing requires BLOB_READ_WRITE_TOKEN in the server environment.";
  }
  return message;
}

function jsonResponse(body: unknown, request: Request, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(request),
      "Content-Type": "application/json"
    }
  });
}

export function OPTIONS(request: Request) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request)
  });
}

export async function POST(request: Request) {
  const originCheck = validateTrustedOrigin(request);
  if (!originCheck.ok) {
    return jsonResponse({ message: originCheck.message }, request, originCheck.status);
  }

  const rateLimit = rateLimitPublishRequest(request);
  if (!rateLimit.ok) {
    return new Response(JSON.stringify({ message: "Publishing is temporarily rate limited." }), {
      status: 429,
      headers: {
        ...buildCorsHeaders(request),
        "Content-Type": "application/json",
        "X-Retry-After": String(rateLimit.retryAfterSeconds),
      },
    });
  }

  const botProtection = await verifyShareBotProtection(request);
  if (!botProtection.ok) {
    return jsonResponse({ message: botProtection.message }, request, botProtection.status);
  }

  const maxBytes = Number.parseInt(getEnv("MAX_BYTES", "262144"), 10);
  const contentType = String(request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return jsonResponse({ message: "Expected application/json" }, request, 415);
  }

  const rawJson = await request.text();
  if (!rawJson) {
    return jsonResponse({ message: "Body is required" }, request, 400);
  }

  if (Buffer.byteLength(rawJson, "utf8") > maxBytes) {
    return jsonResponse({ message: "Bundle exceeds upload limit", maxBytes }, request, 413);
  }

  const validation = validateBundlePayload(rawJson);
  if (!validation.ok) {
    return jsonResponse({ message: validation.message }, request, 422);
  }

  try {
    const { id } = await storeBundleJson(rawJson);
    const urls = buildBundleUrls(
      buildRequestLike({
        headers: request.headers
      }),
      id
    );

    return jsonResponse({ url: urls.shareUrl }, request);
  } catch (error) {
    return jsonResponse({ message: formatPublishError(error) }, request, 500);
  }
}
