import { storeBundleJson } from "../../../../server/_lib/blob-store.ts";
import { packageOpenworkFiles } from "../../../../server/_lib/package-openwork-files.ts";
import { buildBundleUrls, getEnv } from "../../../../server/_lib/share-utils.ts";
import { buildRequestLike } from "../../../../server/_lib/request-like.ts";

export const runtime = "nodejs";

function formatPublishError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Failed to package files";
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

  const raw = await request.text();
  if (!raw) {
    return jsonResponse({ message: "Body is required" }, 400);
  }

  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return jsonResponse({ message: "Package request exceeds upload limit", maxBytes }, 413);
  }

  let body: { preview?: boolean; [key: string]: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ message: "Invalid JSON" }, 422);
  }

  try {
    const packaged = packageOpenworkFiles(body);
    if (body?.preview) {
      return jsonResponse(packaged);
    }

    const { id } = await storeBundleJson(JSON.stringify(packaged.bundle));
    const urls = buildBundleUrls(
      buildRequestLike({
        headers: request.headers
      }),
      id
    );

    return jsonResponse({
      ...packaged,
      url: urls.shareUrl,
      id
    });
  } catch (error) {
    return jsonResponse({ message: formatPublishError(error) }, 422);
  }
}
