import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import type { OpenworkServerClient } from "../lib/openwork-server";
import { isTauriRuntime, safeStringify } from "../utils";
import { parseBundlePayload } from "./schema";
import type { BundleImportIntent, BundleRequest, BundleV1 } from "./types";
import { extractBundleId, isConfiguredBundlePublisherUrl } from "./url-policy";

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const normalized = protocol.toLowerCase();
  return normalized === "openwork:" || normalized === "openwork-dev:" || normalized === "https:" || normalized === "http:";
}

export function normalizeBundleImportIntent(value: string | null | undefined): BundleImportIntent {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "new_worker" || normalized === "new-worker" || normalized === "newworker") {
    return "new_worker";
  }
  return "import_current";
}

export function parseBundleDeepLink(rawUrl: string): BundleRequest | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!isSupportedDeepLinkProtocol(protocol)) {
    return null;
  }

  const routeHost = url.hostname.toLowerCase();
  const routePath = url.pathname.replace(/^\/+/, "").toLowerCase();
  const routeSegments = routePath.split("/").filter(Boolean);
  const routeTail = routeSegments[routeSegments.length - 1] ?? "";
  const looksLikeImportRoute = routeHost === "import-bundle" || routePath === "import-bundle" || routeTail === "import-bundle";

  const rawBundleUrl = url.searchParams.get("ow_bundle") ?? url.searchParams.get("bundleUrl") ?? "";
  if (!looksLikeImportRoute && !rawBundleUrl.trim()) {
    return null;
  }

  try {
    if ((protocol === "https:" || protocol === "http:") && !rawBundleUrl.trim()) {
      if (isConfiguredBundlePublisherUrl(url.toString())) {
        return {
          bundleUrl: url.toString(),
          intent: normalizeBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent")),
          source: url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? undefined,
          label: url.searchParams.get("ow_label")?.trim() ?? url.searchParams.get("label")?.trim() ?? undefined,
        };
      }
    }

    const parsedBundleUrl = new URL(rawBundleUrl.trim());
    if (parsedBundleUrl.protocol !== "https:" && parsedBundleUrl.protocol !== "http:") {
      return null;
    }
    return {
      bundleUrl: parsedBundleUrl.toString(),
      intent: normalizeBundleImportIntent(url.searchParams.get("ow_intent") ?? url.searchParams.get("intent")),
      source: url.searchParams.get("ow_source")?.trim() ?? url.searchParams.get("source")?.trim() ?? undefined,
      label: url.searchParams.get("ow_label")?.trim() ?? url.searchParams.get("label")?.trim() ?? undefined,
    };
  } catch {
    return null;
  }
}

export function stripBundleQuery(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  let changed = false;
  for (const key of ["ow_bundle", "bundleUrl", "ow_intent", "intent", "ow_source", "source", "ow_org", "ow_label"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
}

export async function fetchBundle(
  bundleUrl: string,
  serverClient?: OpenworkServerClient | null,
  options?: { forceClientFetch?: boolean },
): Promise<BundleV1> {
  let targetUrl: URL;
  try {
    targetUrl = new URL(bundleUrl);
  } catch {
    throw new Error("Invalid bundle URL.");
  }

  if (targetUrl.protocol !== "https:" && targetUrl.protocol !== "http:") {
    throw new Error("Bundle URL must use http(s).");
  }

  const bundleId = extractBundleId(targetUrl);
  if (bundleId) {
    targetUrl.pathname = `/b/${bundleId}/data`;
    targetUrl.searchParams.delete("format");
  }

  if (!targetUrl.searchParams.has("format")) {
    targetUrl.searchParams.set("format", "json");
  }

  if (serverClient && !options?.forceClientFetch) {
    return parseBundlePayload(await serverClient.fetchBundle(targetUrl.toString()));
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15_000);

  try {
    let response: Response;
    try {
      response = isTauriRuntime()
        ? await tauriFetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          })
        : await fetch(targetUrl.toString(), {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : safeStringify(error);
      throw new Error(`Failed to load bundle from ${targetUrl.toString()}: ${message}`);
    }
    if (!response.ok) {
      const details = (await response.text()).trim();
      const suffix = details ? `: ${details}` : "";
      throw new Error(`Failed to fetch bundle from ${targetUrl.toString()} (${response.status})${suffix}`);
    }
    return parseBundlePayload(await response.json());
  } finally {
    window.clearTimeout(timeout);
  }
}
