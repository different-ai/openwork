import { ApiError } from "./errors.js";

type PublishBundleInput = {
  payload: unknown;
  bundleType: string;
  name?: string;
  timeoutMs?: number;
};

const DEFAULT_PUBLISHER_BASE_URL = String(process.env.OPENWORK_PUBLISHER_BASE_URL ?? "").trim() || "https://share.openworklabs.com";
const DEFAULT_PUBLISHER_ORIGIN = String(process.env.OPENWORK_PUBLISHER_REQUEST_ORIGIN ?? "").trim() || "https://app.openwork.software";
const ALLOWED_BUNDLE_TYPES = new Set(["skill", "skills-set", "workspace-profile"]);

export function normalizeSharedBundleFetchUrl(input: URL): URL {
  const url = new URL(input.toString());
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "b" && segments[1] && segments.length === 2) {
    url.pathname = `/b/${segments[1]}/data`;
    url.searchParams.delete("format");
  } else if (segments[0] === "b" && segments[1] && segments[2] === "data") {
    url.searchParams.delete("format");
  }
  return url;
}

function normalizeBaseUrl(input: unknown): string {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    throw new ApiError(500, "publisher_base_url_missing", "Publisher base URL is required");
  }
  return trimmed.replace(/\/+$/, "");
}

function resolvePublisherBaseUrl(): string {
  return normalizeBaseUrl(DEFAULT_PUBLISHER_BASE_URL);
}

function extractBundleId(url: URL): string {
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0] === "b" && segments[1] && (segments.length === 2 || (segments.length === 3 && segments[2] === "data"))) {
    return segments[1];
  }
  throw new ApiError(400, "invalid_bundle_url", "Shared bundle URL must point to a bundle id");
}

export function resolveTrustedSharedBundleFetchUrl(bundleUrl: unknown): URL {
  let inputUrl: URL;
  try {
    inputUrl = new URL(String(bundleUrl ?? "").trim());
  } catch {
    throw new ApiError(400, "invalid_bundle_url", "Invalid shared bundle URL");
  }

  if (inputUrl.protocol !== "https:" && inputUrl.protocol !== "http:") {
    throw new ApiError(400, "invalid_bundle_url", "Shared bundle URL must use http(s)");
  }

  const trustedBaseUrl = new URL(resolvePublisherBaseUrl());
  if (inputUrl.origin !== trustedBaseUrl.origin) {
    throw new ApiError(
      400,
      "untrusted_bundle_url",
      `Shared bundle URLs must use the configured OpenWork publisher (${trustedBaseUrl.origin}). Import only bundles from trusted sources.`,
    );
  }

  const bundleId = extractBundleId(inputUrl);
  trustedBaseUrl.pathname = `/b/${bundleId}/data`;
  trustedBaseUrl.search = "";
  return trustedBaseUrl;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text();
    if (!text.trim()) return "";
    try {
      const json = JSON.parse(text) as Record<string, unknown>;
      if (typeof json.message === "string" && json.message.trim()) {
        return json.message.trim();
      }
    } catch {
      // ignore
    }
    return text.trim();
  } catch {
    return "";
  }
}

export async function publishSharedBundle(input: PublishBundleInput): Promise<{ url: string }> {
  const bundleType = String(input.bundleType ?? "").trim();
  if (!ALLOWED_BUNDLE_TYPES.has(bundleType)) {
    throw new ApiError(400, "invalid_bundle_type", `Unsupported bundle type: ${bundleType || "unknown"}`);
  }

  const baseUrl = resolvePublisherBaseUrl();
  const timeoutMs = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const response = await fetch(`${baseUrl}/v1/bundles`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: DEFAULT_PUBLISHER_ORIGIN,
        "X-OpenWork-Bundle-Type": bundleType,
        "X-OpenWork-Schema-Version": "v1",
        ...(input.name?.trim() ? { "X-OpenWork-Name": input.name.trim() } : {}),
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(502, "bundle_publish_failed", "Publisher redirects are not allowed");
    }

    if (!response.ok) {
      const details = await readErrorMessage(response);
      const suffix = details ? `: ${details}` : "";
      throw new ApiError(502, "bundle_publish_failed", `Publish failed (${response.status})${suffix}`);
    }

    const json = (await response.json()) as Record<string, unknown>;
    const url = typeof json.url === "string" ? json.url.trim() : "";
    if (!url) {
      throw new ApiError(502, "bundle_publish_failed", "Publisher response missing url");
    }
    return { url };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(502, "bundle_publish_failed", `Failed to publish bundle: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSharedBundle(bundleUrl: unknown, options?: { timeoutMs?: number }): Promise<unknown> {
  const url = resolveTrustedSharedBundleFetchUrl(bundleUrl);

  const timeoutMs = typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeoutMs));

  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (response.status >= 300 && response.status < 400) {
      throw new ApiError(502, "bundle_fetch_failed", "Shared bundle redirects are not allowed");
    }

    if (!response.ok) {
      const details = await readErrorMessage(response);
      const suffix = details ? `: ${details}` : "";
      throw new ApiError(502, "bundle_fetch_failed", `Failed to fetch bundle (${response.status})${suffix}`);
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(502, "bundle_fetch_failed", `Failed to fetch bundle: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}
