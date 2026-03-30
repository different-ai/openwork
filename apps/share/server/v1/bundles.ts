import type { IncomingMessage, ServerResponse } from "node:http";

import { storeBundleJson } from "../_lib/blob-store.ts";
import { buildCanonicalRequest, buildRequestLike } from "../_lib/request-like.ts";
import { buildCorsHeaders, rateLimitPublishRequest, validateTrustedOrigin, verifyShareBotProtection } from "../_lib/publish-security.ts";
import { buildBundleUrls, getEnv, readBody, validateBundlePayload } from "../_lib/share-utils.ts";

interface LegacyApiRequest extends IncomingMessage {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface LegacyApiResponse extends ServerResponse {
  status(code: number): LegacyApiResponse;
  json(body: unknown): void;
}

function formatPublishError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Blob put failed";
  if (message.includes("BLOB_READ_WRITE_TOKEN") || message.includes("No token found")) {
    return "Publishing requires BLOB_READ_WRITE_TOKEN in the server environment.";
  }
  return message;
}

function applyHeaders(res: LegacyApiResponse, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
}

function json(res: LegacyApiResponse, body: unknown, status = 200, headers: Record<string, string> = {}): void {
  applyHeaders(res, {
    ...headers,
    "Content-Type": "application/json",
  });
  res.status(status).end(JSON.stringify(body));
}

export default async function handler(req: LegacyApiRequest, res: LegacyApiResponse): Promise<void> {
  const request = buildCanonicalRequest({
    pathname: "/v1/bundles",
    method: req.method,
    headers: req.headers,
  });

  applyHeaders(res, buildCorsHeaders(request));
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const originCheck = validateTrustedOrigin(request);
  if (!originCheck.ok) {
    json(res, { message: originCheck.message }, originCheck.status);
    return;
  }

  const rateLimit = rateLimitPublishRequest(request);
  if (!rateLimit.ok) {
    json(
      res,
      { message: "Publishing is temporarily rate limited." },
      429,
      { "X-Retry-After": String(rateLimit.retryAfterSeconds) },
    );
    return;
  }

  const botProtection = await verifyShareBotProtection(request);
  if (!botProtection.ok) {
    json(res, { message: botProtection.message }, botProtection.status);
    return;
  }

  if (req.method !== "POST") {
    json(res, { message: "Method not allowed" }, 405);
    return;
  }

  const maxBytes = Number.parseInt(getEnv("MAX_BYTES", "5242880"), 10);

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.includes("application/json")) {
    json(res, { message: "Expected application/json" }, 415);
    return;
  }

  const raw = await readBody(req);
  if (!raw || raw.length === 0) {
    json(res, { message: "Body is required" }, 400);
    return;
  }
  if (raw.length > maxBytes) {
    json(res, { message: "Bundle exceeds upload limit", maxBytes }, 413);
    return;
  }

  const rawJson = raw.toString("utf8");
  const validation = validateBundlePayload(rawJson);
  if (!validation.ok) {
    json(res, { message: validation.message }, 422);
    return;
  }

  try {
    const { id } = await storeBundleJson(rawJson);
    const urls = buildBundleUrls(buildRequestLike({ headers: request.headers }), id);
    json(res, { url: urls.shareUrl });
  } catch (e) {
    json(res, { message: formatPublishError(e) }, 500);
  }
}
