import type { RequestLike } from "./types.ts";
import { getPublicBaseUrl } from "./share-utils.ts";

export function headersToObject(
  headersInput: Headers | Record<string, string | string[] | undefined> | null,
): Record<string, string> {
  const result: Record<string, string> = {};

  if (!headersInput) return result;

  if (typeof (headersInput as Headers).forEach === "function") {
    (headersInput as Headers).forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value);
    });
    return result;
  }

  for (const [key, value] of Object.entries(headersInput)) {
    if (value == null) continue;
    result[String(key).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }

  return result;
}

export function searchParamsToQuery(searchParams: URLSearchParams | null): Record<string, string> {
  if (!searchParams || typeof searchParams.entries !== "function") {
    return {};
  }

  return Object.fromEntries(searchParams.entries());
}

export function buildRequestLike({
  headers,
  searchParams,
}: {
  headers?: Headers | Record<string, string | string[] | undefined> | null;
  searchParams?: URLSearchParams | null;
} = {}): RequestLike {
  return {
    headers: headersToObject(headers ?? null),
    query: searchParamsToQuery(searchParams ?? null),
  };
}

export function buildCanonicalRequest({
  pathname,
  method,
  headers,
  searchParams,
}: {
  pathname: string;
  method?: string;
  headers?: Headers | Record<string, string | string[] | undefined> | null;
  searchParams?: URLSearchParams | null;
}): Request {
  const url = new URL(pathname, `${getPublicBaseUrl()}/`);
  const query = searchParamsToQuery(searchParams ?? null);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  return new Request(url.toString(), {
    method: method ?? "GET",
    headers: new Headers(headersToObject(headers ?? null)),
  });
}
