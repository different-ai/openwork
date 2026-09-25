import { readFile } from "node:fs/promises";
import { originReplacements, replaceOrigins, templateOrigins } from "./origins.mjs";

// Den keeps the snapshot's template origins and the gateway translates them for
// browsers. Den also sends them straight to third parties: an OAuth provider would
// get the template callback in client registration and token requests while the
// browser returns to this clone's. Preloaded into Den (`--import`), this applies
// the gateway's translation to requests leaving the VM too.
const accessFile = process.env.OPENWORK_PREVIEW_ACCESS_FILE ?? "/opt/openwork-preview/access.json";
const templateHosts = Object.values(templateOrigins).map((origin) => new URL(origin).hostname);
const mentionsTemplate = (text) => templateHosts.some((host) => text.includes(host));

function staysInside(url) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || host.startsWith("127.")
    || templateHosts.includes(host);
}

// Read on use: the snapshot resumes this process in every clone, and each clone
// writes its own origins after it starts.
async function clonePairs() {
  try {
    const { origins, templateOrigins: from } = JSON.parse(await readFile(accessFile, "utf8"));
    return originReplacements(from, origins);
  } catch { return []; }
}

/** Wraps fetch so template origins in an outbound URL or text body become this clone's. */
export function previewEgress(send, readPairs = clonePairs) {
  return async (input, init) => {
    if ((typeof input !== "string" && !(input instanceof URL)) || !URL.canParse(input)) return send(input, init);
    const url = new URL(input);
    const body = init?.body;
    const text = typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : null;
    if (staysInside(url) || !(mentionsTemplate(url.href) || (text !== null && mentionsTemplate(text)))) return send(input, init);
    const pairs = await readPairs();
    if (pairs.length === 0) return send(input, init);
    const translated = new URL(replaceOrigins(url.href, pairs));
    if (text === null || !mentionsTemplate(text)) return send(translated, init);
    const headers = new Headers(init.headers);
    headers.delete("content-length");
    const next = replaceOrigins(text, pairs);
    return send(translated, { ...init, headers, body: typeof body === "string" ? next : new URLSearchParams(next) });
  };
}

const installed = Symbol.for("openwork.preview.egress");
if (typeof globalThis.fetch === "function" && !globalThis.fetch[installed]) {
  const fetch = previewEgress(globalThis.fetch);
  fetch[installed] = true;
  globalThis.fetch = fetch;
}
