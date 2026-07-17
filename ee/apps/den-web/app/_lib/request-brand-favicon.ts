import { headers } from "next/headers";
import { getBrandFavicon } from "../(den)/_lib/brand-favicon";
import { parseOrgContextPayload } from "../(den)/_lib/den-org";

const BRAND_FAVICON_LOOKUP_TIMEOUT_MS = 2_000;

type RequestHeaders = {
  get(name: string): string | null;
};

type RequestBrandFaviconDependencies = {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function denApiBase() {
  return process.env.DEN_API_BASE?.trim().replace(/\/+$/, "") || null;
}

function copyRequestAuthentication(requestHeaders: RequestHeaders) {
  const upstreamHeaders = new Headers({ accept: "application/json" });

  for (const name of ["cookie", "authorization"]) {
    const value = requestHeaders.get(name);
    if (value) {
      upstreamHeaders.set(name, value);
    }
  }

  return upstreamHeaders;
}

export async function getBrandFaviconForRequest(
  requestHeaders: RequestHeaders,
  dependencies: RequestBrandFaviconDependencies = {},
) {
  const upstreamHeaders = copyRequestAuthentication(requestHeaders);
  const apiBase = dependencies.apiBase ?? denApiBase();

  if (!apiBase || (!upstreamHeaders.has("cookie") && !upstreamHeaders.has("authorization"))) {
    return getBrandFavicon(null);
  }

  try {
    const response = await (dependencies.fetchImpl ?? fetch)(`${apiBase}/v1/org`, {
      headers: upstreamHeaders,
      cache: "no-store",
      signal: AbortSignal.timeout(dependencies.timeoutMs ?? BRAND_FAVICON_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      return getBrandFavicon(null);
    }

    const payload: unknown = await response.json();
    return getBrandFavicon(parseOrgContextPayload(payload)?.organization.metadata);
  } catch {
    return getBrandFavicon(null);
  }
}

export async function getRequestBrandFavicon() {
  return getBrandFaviconForRequest(await headers());
}
