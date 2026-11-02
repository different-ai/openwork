import { writeFile } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { join, resolve } from "node:path";

import { ApiError } from "../errors.js";
import { ensureDir } from "../utils.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import type { ServerConfig } from "../types.js";

/**
 * Design section server surfaces:
 *
 * - `POST /workspace/:id/design/references/capture` — download a reference
 *   image from a public web page (og:image) into the workspace's
 *   `context/design/referencias/` folder, with a JSON sidecar recording the
 *   source URL. The user browses curated catalogs (Refero, Designeer) or any
 *   site and captures what they like; the agent later reads these files.
 * - `GET /design/catalog/designeer` — read-only proxy of the Designeer
 *   hand-reviewed catalog (`designeer.xyz/index.md`), which publishes its
 *   listing as Markdown with cursor pagination. Text only; nothing is copied
 *   beyond what the page itself publishes for readers.
 */

const REFERENCES_DIRECTORY = "context/design/referencias";
const MAX_HTML_BYTES = 3_000_000;
const MAX_IMAGE_BYTES = 8_000_000;
const PAGE_FETCH_TIMEOUT_MS = 12_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const DESIGNEER_INDEX_URL = "https://designeer.xyz/index.md";
const DESIGNEER_CACHE_TTL_MS = 5 * 60 * 1000;

const IMAGE_EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
};

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterDesignRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  resolveWorkspace: (config: ServerConfig, workspaceId: string) => Promise<{ id: string; path: string }>;
}

/** A public, non-loopback IPv4/IPv6 address. Textual check over the final IP. */
export function isPublicAddress(address: string): boolean {
  const value = address.toLowerCase();
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return false;
    if (value.startsWith("fc") || value.startsWith("fd")) return false; // fc00::/7 unique local
    if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return false; // fe80::/10 link-local
    if (value.startsWith("::ffff:")) return isPublicAddress(value.slice("::ffff:".length));
    return true;
  }
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a >= 224) return false; // multicast + reserved
  return true;
}

/** Require an http(s) URL whose host is public by name and by resolved address. */
async function resolvePublicHttpUrl(value: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, "invalid_url", "La URL no es válida.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ApiError(400, "invalid_url", "Solo se admiten URLs http(s).");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || hostname === "metadata.google.internal") {
    throw new ApiError(400, "invalid_url", "No se admiten hosts internos.");
  }
  let addresses: Array<{ address: string }> = [];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new ApiError(400, "dns_failed", "No se pudo resolver el host.");
  }
  if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new ApiError(400, "private_host", "El host no es público.");
  }
  return url;
}

function firstMetaContent(html: string, keys: readonly string[]): string | null {
  for (const key of keys) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key.replace(/["']/g, "")}["'][^>]*>`,
      "i",
    );
    const tag = pattern.exec(html)?.[0];
    if (!tag) continue;
    const content = /content=["']([^"']+)["']/i.exec(tag)?.[1];
    if (content?.trim()) return content.trim();
  }
  return null;
}

/** og:image (with twitter:image fallback) and og:title from an HTML page. */
export function extractOpenGraphMetadata(html: string, baseUrl: string): { imageUrl: string | null; title: string | null } {
  const rawImage = firstMetaContent(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]);
  const rawTitle = firstMetaContent(html, ["og:title", "twitter:title"]) ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? null;
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      imageUrl = new URL(rawImage, baseUrl).toString();
    } catch {
      imageUrl = null;
    }
  }
  const title = rawTitle?.trim() ? rawTitle.trim().slice(0, 200) : null;
  return { imageUrl, title };
}

export function slugFromTitle(title: string | null, fallback: string): string {
  const source = (title ?? fallback).toLowerCase();
  const slug = source.replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || fallback;
}

export function referenceImageExtension(contentType: string | null, imageUrl: URL): string {
  if (contentType) {
    const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    if (IMAGE_EXTENSION_BY_CONTENT_TYPE[base]) return IMAGE_EXTENSION_BY_CONTENT_TYPE[base]!;
  }
  const match = /\.(png|jpe?g|webp|gif|svg|avif)(?:[?#]|$)/i.exec(imageUrl.pathname + imageUrl.search);
  if (match) {
    const ext = match[1]!.toLowerCase();
    return ext === "jpeg" ? ".jpg" : `.${ext}`;
  }
  return ".png";
}

/** One Designeer listing as its index.md publishes it. */
export type DesigneerItem = {
  title: string;
  url: string;
  author: string | null;
  description: string | null;
};

/** Parse the public `designeer.xyz/index.md` listing: `## Latest finds` links
 * plus the trailing next-page cursor. */
export function parseDesigneerIndex(markdown: string): { items: DesigneerItem[]; nextCursor: string | null } {
  const items: DesigneerItem[] = [];
  const seen = new Set<string>();
  const linkPattern = /^- \[(.+?)\]\((\/finds\/[^)\s]+|https:\/\/designeer\.xyz\/finds\/[^)\s]+)\)(?: - (.+))?$/gm;
  for (const match of markdown.matchAll(linkPattern)) {
    const title = match[1]!.trim();
    const path = match[2]!.trim();
    const description = match[3]?.trim() ?? null;
    const url = path.startsWith("http") ? path : `https://designeer.xyz${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const authorMatch = /^Find by (.+)$/.exec(title);
    items.push({
      title: authorMatch ? `Find by ${authorMatch[1]!.trim()}` : title,
      url,
      author: authorMatch ? authorMatch[1]!.trim() : null,
      description,
    });
  }
  const cursorMatch = /\/index\.md\?cursor=([^)\s]+)/.exec(markdown);
  return { items, nextCursor: cursorMatch ? decodeURIComponent(cursorMatch[1]!) : null };
}

let designeerCache: { at: number; text: string } | null = null;

async function fetchDesigneerIndex(cursor: string | null): Promise<string> {
  if (!cursor && designeerCache && Date.now() - designeerCache.at < DESIGNEER_CACHE_TTL_MS) {
    return designeerCache.text;
  }
  const url = cursor ? `${DESIGNEER_INDEX_URL}?cursor=${encodeURIComponent(cursor)}` : DESIGNEER_INDEX_URL;
  const response = await fetch(url, { signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!response.ok) throw new ApiError(502, "catalog_unavailable", "El catálogo de Designeer no está disponible ahora mismo.");
  const text = await response.text();
  if (!cursor) designeerCache = { at: Date.now(), text };
  return text;
}

async function fetchBounded(url: string, maxBytes: number, timeoutMs: number): Promise<{ buffer: ArrayBuffer; contentType: string | null }> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
    headers: { "user-agent": "OpenWorkDesignCapture/1.0", accept: "text/html,image/*" },
  });
  if (!response.ok) throw new ApiError(502, "fetch_failed", `La página respondió ${response.status}.`);
  const contentType = response.headers.get("content-type");
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "too_large", "El recurso excede el tamaño máximo.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new ApiError(413, "too_large", "El recurso excede el tamaño máximo.");
  return { buffer, contentType };
}

export function registerDesignRoutes(options: RegisterDesignRoutesOptions): void {
  const { routes, config, jsonResponse, readJsonBody, resolveWorkspace } = options;

  addRoute(routes, "POST", "/workspace/:id/design/references/capture", "client", async (ctx: RequestContext) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const rawUrl = typeof body.url === "string" ? body.url.trim() : "";
    if (!rawUrl) throw new ApiError(400, "invalid_url", "Falta la URL.");
    const pageUrl = await resolvePublicHttpUrl(rawUrl);

    const { buffer: htmlBuffer } = await fetchBounded(pageUrl.toString(), MAX_HTML_BYTES, PAGE_FETCH_TIMEOUT_MS);
    const html = new TextDecoder().decode(htmlBuffer.slice(0, MAX_HTML_BYTES));
    const metadata = extractOpenGraphMetadata(html, pageUrl.toString());
    if (!metadata.imageUrl) {
      throw new ApiError(422, "no_image", "La página no expone imagen (og:image). Haz un pantallazo y súbelo como referencia.");
    }
    const imageUrl = await resolvePublicHttpUrl(metadata.imageUrl);
    const { buffer: imageBuffer, contentType } = await fetchBounded(imageUrl.toString(), MAX_IMAGE_BYTES, IMAGE_FETCH_TIMEOUT_MS);
    const effectiveType = contentType?.startsWith("image/") ? contentType : contentType;
    if (effectiveType && !effectiveType.startsWith("image/")) {
      throw new ApiError(422, "not_an_image", "La URL no apunta a una imagen.");
    }

    const extension = referenceImageExtension(effectiveType ?? null, imageUrl);
    const slug = slugFromTitle(metadata.title, pageUrl.hostname.replace(/^www\./, ""));
    const stem = `${Date.now()}-${slug}`;
    const imagePath = `${REFERENCES_DIRECTORY}/${stem}${extension}`;
    const sidecarPath = `${REFERENCES_DIRECTORY}/${stem}.json`;
    const sidecar = {
      kind: "capture",
      sourceUrl: pageUrl.toString(),
      imageUrl: metadata.imageUrl,
      title: metadata.title,
      capturedAt: new Date().toISOString(),
    };

    const absoluteDirectory = resolve(join(workspace.path, REFERENCES_DIRECTORY));
    await ensureDir(absoluteDirectory);
    await writeFile(join(absoluteDirectory, `${stem}${extension}`), Buffer.from(imageBuffer));
    await writeFile(join(absoluteDirectory, `${stem}.json`), JSON.stringify(sidecar, null, 2), "utf8");

    return jsonResponse({
      items: [
        { path: imagePath, sourceUrl: pageUrl.toString(), title: metadata.title, bytes: imageBuffer.byteLength },
      ],
    });
  });

  addRoute(routes, "GET", "/design/catalog/designeer", "client", async (ctx: RequestContext) => {
    const cursorParam = new URL(ctx.request.url).searchParams.get("cursor");
    const cursor = cursorParam?.trim() ? cursorParam.trim() : null;
    const text = await fetchDesigneerIndex(cursor);
    const { items, nextCursor } = parseDesigneerIndex(text);
    return jsonResponse({ items, nextCursor });
  });
}
