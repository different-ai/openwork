import { headers } from "next/headers";
import { getBrandFavicon } from "../(den)/_lib/brand-favicon";
import { parseOrgContextPayload } from "../(den)/_lib/den-org";

function denApiBase() {
  return process.env.DEN_API_BASE?.trim().replace(/\/+$/, "") || null;
}

function copyRequestAuthentication(requestHeaders: { get(name: string): string | null }) {
  const upstreamHeaders = new Headers({ accept: "application/json" });

  for (const name of ["cookie", "authorization"]) {
    const value = requestHeaders.get(name);
    if (value) {
      upstreamHeaders.set(name, value);
    }
  }

  return upstreamHeaders;
}

export async function getRequestBrandFavicon() {
  const requestHeaders = await headers();
  const upstreamHeaders = copyRequestAuthentication(requestHeaders);
  const apiBase = denApiBase();

  if (!apiBase || (!upstreamHeaders.has("cookie") && !upstreamHeaders.has("authorization"))) {
    return getBrandFavicon(null);
  }

  try {
    const response = await fetch(`${apiBase}/v1/org`, {
      headers: upstreamHeaders,
      cache: "no-store",
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
