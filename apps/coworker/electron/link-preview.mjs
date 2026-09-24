import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Link previews for URLs shared in a conversation, the way a messaging app
 * shows them: title, description, site and a small image read from the page's
 * own metadata. The main process fetches them so the renderer never contacts a
 * third party itself. Only public http(s) hosts are read; loopback, private and
 * link-local addresses are refused before connecting and after every redirect.
 * Reads are small and short, and the image comes back inline, bounded in size.
 */
// Some pages (YouTube) put their preview tags deep in the page; reading stops as
// soon as a title and an image have arrived, and never goes past this ceiling.
const PAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_BYTES = 400 * 1024;
const TIMEOUT_MS = 5_000;
const REDIRECTS = 3;
const CACHE_LIMIT = 200;
const CACHE_MS = 60 * 60_000;
const TEXT_LIMIT = 300;

function privateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]);
    return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8")
      || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff");
  }
  return true;
}

/** The URL, if it is an http(s) address on a public host; otherwise null. */
export async function publicUrl(value, resolve = lookup) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return null;
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) return null;
  return url;
}

const decodeEntities = (text) => text
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const clean = (text) => decodeEntities(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, TEXT_LIMIT);

/** Title, description, site and image from a page's head, preferring Open Graph and Twitter tags. */
export function pageMetadata(html, pageUrl) {
  const head = html.slice(0, PAGE_BYTES);
  const meta = new Map();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i);
    if (key && content && !meta.has(key)) meta.set(key, content[1] ?? content[2] ?? "");
  }
  const first = (...keys) => keys.map((key) => meta.get(key)).find((value) => value && value.trim()) ?? "";
  const title = clean(first("og:title", "twitter:title") || head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const video = /^video/i.test(first("og:type")) || Boolean(first("og:video", "og:video:url", "og:video:secure_url", "twitter:player"));
  const description = clean(first("og:description", "twitter:description", "description"));
  const siteName = clean(first("og:site_name", "application-name")) || pageUrl.hostname.replace(/^www\./, "");
  let image = "";
  const imageValue = first("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src").trim();
  if (imageValue) { try { image = new URL(decodeEntities(imageValue), pageUrl).href; } catch { image = ""; } }
  return { title, description, siteName, image, video };
}

/** A page has said enough for a preview once its title and image tags are both in. */
const describedEnough = (html) => /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og|twitter):title["'][^>]*>/i.test(html)
  && /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og|twitter):image["'][^>]*>/i.test(html);

async function readLimited(response, limit, enough) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const decoder = enough ? new TextDecoder() : null;
  let text = "";
  const chunks = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (decoder) {
      text += decoder.decode(value, { stream: true });
      if (enough(text)) break;
    }
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(total, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.byteLength - offset));
    bytes.set(part, offset);
    offset += part.byteLength;
    if (offset >= bytes.byteLength) break;
  }
  return bytes;
}

/** Follow at most a few redirects by hand, checking every hop is still a public host. */
async function publicFetch(value, accept, { fetchImpl, resolve }) {
  let url = await publicUrl(value, resolve);
  for (let hop = 0; url && hop <= REDIRECTS; hop += 1) {
    const response = await fetchImpl(url.href, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept, "user-agent": "Mozilla/5.0 (Macintosh) OpenCoworker-LinkPreview" } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      url = await publicUrl(new URL(response.headers.get("location"), url).href, resolve);
      continue;
    }
    return response.ok ? { response, url } : null;
  }
  return null;
}

export function createLinkPreviews({ fetchImpl = fetch, resolve = lookup, now = Date.now } = {}) {
  const cache = new Map();

  async function load(value) {
    const page = await publicFetch(value, "text/html,application/xhtml+xml", { fetchImpl, resolve });
    if (!page || !/html/i.test(page.response.headers.get("content-type") ?? "")) {
      await page?.response.body?.cancel().catch(() => undefined);
      return null;
    }
    const html = new TextDecoder().decode(await readLimited(page.response, PAGE_BYTES, describedEnough));
    const metadata = pageMetadata(html, page.url);
    if (!metadata.title && !metadata.description) return null;
    let image = "";
    if (metadata.image) {
      const picture = await publicFetch(metadata.image, "image/*", { fetchImpl, resolve }).catch(() => null);
      const type = picture?.response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const length = Number(picture?.response.headers.get("content-length") ?? 0);
      if (picture && /^image\/(png|jpe?g|gif|webp)$/i.test(type) && length <= IMAGE_BYTES) {
        const bytes = await readLimited(picture.response, IMAGE_BYTES + 1);
        if (bytes.byteLength <= IMAGE_BYTES) image = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
      } else await picture?.response.body?.cancel().catch(() => undefined);
    }
    return { url: page.url.href, title: metadata.title, description: metadata.description, siteName: metadata.siteName, image, video: metadata.video };
  }

  return {
    /** The preview for a shared URL, or null when it is not public, not HTML, or has nothing to show. */
    async read(value) {
      if (typeof value !== "string" || value.length > 2048) return null;
      const cached = cache.get(value);
      if (cached && now() - cached.at < CACHE_MS) return cached.preview;
      const preview = await load(value).catch(() => null);
      cache.delete(value);
      cache.set(value, { at: now(), preview });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
      return preview;
    },
  };
}
