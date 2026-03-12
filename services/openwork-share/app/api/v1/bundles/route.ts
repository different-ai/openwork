import { storeBundleJson } from "../../../../server/_lib/blob-store.ts";
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

function buildCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Accept,X-OpenWork-Bundle-Type,X-OpenWork-Schema-Version,X-OpenWork-Name"
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...buildCorsHeaders(),
      "Content-Type": "application/json"
    }
  });
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders()
  });
}

export async function POST(request: Request) {
  const maxBytes = Number.parseInt(getEnv("MAX_BYTES", "5242880"), 10);
  const contentType = String(request.headers.get("content-type") ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    return jsonResponse({ message: "Expected application/json" }, 415);
  }

  const rawJson = await request.text();
  if (!rawJson) {
    return jsonResponse({ message: "Body is required" }, 400);
  }

  if (Buffer.byteLength(rawJson, "utf8") > maxBytes) {
    return jsonResponse({ message: "Bundle exceeds upload limit", maxBytes }, 413);
  }

  const validation = validateBundlePayload(rawJson);
  if (!validation.ok) {
    return jsonResponse({ message: validation.message }, 422);
  }

  try {
    const { id } = await storeBundleJson(rawJson);
    const urls = buildBundleUrls(
      buildRequestLike({
        headers: request.headers
      }),
      id
    );

    return jsonResponse({ url: urls.shareUrl });
  } catch (error) {
    return jsonResponse({ message: formatPublishError(error) }, 500);
  }
}
