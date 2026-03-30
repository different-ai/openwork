import type { IncomingMessage, ServerResponse } from "node:http";

import { storeBundleJson } from "../_lib/blob-store.ts";
import { packageOpenworkFiles } from "../_lib/package-openwork-files.ts";
import { buildCanonicalRequest, buildRequestLike } from "../_lib/request-like.ts";
import { buildCorsHeaders, rateLimitPublishRequest, validateTrustedOrigin, verifyShareBotProtection } from "../_lib/publish-security.ts";
import { buildBundleUrls, getEnv, readBody } from "../_lib/share-utils.ts";

interface LegacyApiRequest extends IncomingMessage {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface LegacyApiResponse extends ServerResponse {
  status(code: number): LegacyApiResponse;
  json(body: unknown): void;
}

function formatPublishError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Failed to package files";
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
    pathname: "/v1/package",
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
    json(res, { message: "Package request exceeds upload limit", maxBytes }, 413);
    return;
  }

  let body: { preview?: boolean; [key: string]: unknown };
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    json(res, { message: "Invalid JSON" }, 422);
    return;
  }

  try {
    const packaged = packageOpenworkFiles(body);
    if (body?.preview) {
      json(res, packaged);
      return;
    }

    const { id } = await storeBundleJson(JSON.stringify(packaged.bundle));
    const urls = buildBundleUrls(buildRequestLike({ headers: request.headers }), id);
    json(res, {
      ...packaged,
      url: urls.shareUrl,
      id,
    });
  } catch (error) {
    json(res, { message: formatPublishError(error) }, 422);
  }
}
