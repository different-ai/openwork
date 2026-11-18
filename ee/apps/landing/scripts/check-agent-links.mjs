#!/usr/bin/env node
// Checks that every URL agents are told to use resolves.
//
//   node scripts/check-agent-links.mjs --base-url http://localhost:3005 [--offline] [--strict]
//
// Sources: public/llms.txt, every public/.well-known/agent-skills/*/SKILL.md,
// the MCP discovery files, and packages/docs/start-here/use-openwork-from-an-ai-agent.mdx.
//
// - openworklabs.com routes served by this app are fetched from --base-url
//   (a local `next start`), so new routes are checked before they deploy.
// - openworklabs.com/docs/* is proxied to Mintlify. A live 404 passes as
//   "pending deploy" when the page exists in packages/docs (fails with --strict).
// - Everything else is fetched live. --offline skips external URLs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const landing = join(here, "..");
const docsDir = join(landing, "../../../packages/docs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const baseUrl = (option("--base-url") ?? process.env.LANDING_BASE_URL ?? "").replace(/\/$/, "");
const offline = flag("--offline");
const strict = flag("--strict");

if (!baseUrl) {
  console.error("Usage: node scripts/check-agent-links.mjs --base-url http://localhost:<port> [--offline] [--strict]");
  process.exit(2);
}

const skillsDir = join(landing, "public/.well-known/agent-skills");
const sources = [
  join(landing, "public/llms.txt"),
  join(landing, "public/.well-known/mcp.json"),
  join(landing, "public/.well-known/mcp/server-card.json"),
  join(docsDir, "start-here/use-openwork-from-an-ai-agent.mdx"),
  ...readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(skillsDir, entry.name, "SKILL.md")),
];

// Placeholders and examples inside the sources, not real links.
const ignored = [/<[^>]*>/, /example\.com/, /your-den-web-host/];
// Endpoints that answer GET with an auth or method error by design.
const expectedStatus = new Map([
  ["https://api.openworklabs.com/mcp/agent", [401, 405, 406]],
]);
// OAuth issuer identifiers are not documents; check their RFC 8414 metadata instead.
const probeInstead = new Map([
  ["https://app.openworklabs.com/api/auth", "https://app.openworklabs.com/.well-known/oauth-authorization-server/api/auth"],
]);

const urls = new Map();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/https?:\/\/[^\s)<>`"'|\]]+/g)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    // Templated hosts such as https://api.<your-host>/... are examples.
    if (text[match.index + match[0].length] === "<") continue;
    if (ignored.some((pattern) => pattern.test(url))) continue;
    if (!urls.has(url)) urls.set(url, new Set());
    urls.get(url).add(file.replace(`${landing}/`, "").replace(`${docsDir}/`, "docs/"));
  }
}

async function probe(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    // Some hosts reject HEAD; fall back to GET.
    let response = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal, ...init });
    if (response.status === 405 || response.status === 403 || response.status === 404) {
      response = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal, ...init });
    }
    return { status: response.status, finalUrl: response.url };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const [url, files] of urls) {
  const parsed = new URL(url);
  const isSite = parsed.hostname === "openworklabs.com";
  const isDocs = isSite && (parsed.pathname === "/docs" || parsed.pathname.startsWith("/docs/"));
  const local = isSite && !isDocs;
  if (!local && offline) {
    results.push({ url, verdict: "skip", note: "offline" });
    continue;
  }
  const target = local ? `${baseUrl}${parsed.pathname}${parsed.search}` : probeInstead.get(url) ?? url;
  const { status, finalUrl, error } = await probe(target);
  const allowed = expectedStatus.get(url) ?? [];
  if ((status >= 200 && status < 400) || allowed.includes(status)) {
    const note = local ? `local ${status}${finalUrl && finalUrl !== target ? ` -> ${finalUrl}` : ""}` : String(status);
    results.push({ url, verdict: "ok", note });
    continue;
  }
  if (isDocs && status === 404) {
    const slug = parsed.pathname.replace(/^\/docs\/?/, "").replace(/\.md$/, "");
    if (existsSync(join(docsDir, `${slug}.mdx`))) {
      results.push({ url, verdict: strict ? "fail" : "pending", note: "404 live; page exists in packages/docs (pending deploy)" });
      continue;
    }
  }
  results.push({ url, verdict: "fail", note: `${status || error} (from ${[...files].join(", ")})` });
}

for (const result of results) {
  console.log(`${result.verdict.padEnd(7)} ${result.url}  ${result.note}`);
}
const failed = results.filter((result) => result.verdict === "fail");
const counts = ["ok", "pending", "skip", "fail"].map((verdict) => `${verdict}=${results.filter((r) => r.verdict === verdict).length}`);
console.log(`\n${urls.size} URLs: ${counts.join(" ")}`);
process.exit(failed.length > 0 ? 1 : 0);
