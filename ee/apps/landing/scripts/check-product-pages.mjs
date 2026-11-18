#!/usr/bin/env node
// Read-only check that the four product pages are first-class: reachable from
// the Products menu and each other, indexed, readable by agents, and free of
// dead links. Runs against a landing build that is already serving.
//
//   node scripts/check-product-pages.mjs --base-url http://localhost:3081
import assert from "node:assert/strict";

const index = process.argv.indexOf("--base-url");
const base = index >= 0 ? process.argv[index + 1] : undefined;
if (!base) throw new Error("Pass --base-url for the running landing build.");
const origin = new URL(base);
const canonicalOrigin = "https://openworklabs.com";

// The Products menu, in order. `faq` is false for a page with no FAQ section.
const products = [
  { path: "/connect", name: "MCP Gateway", faq: false },
  { path: "/ai-gateway", name: "AI Gateway", faq: true },
  { path: "/desktop", name: "Desktop App", faq: true },
  { path: "/cloud", name: "Cloud App", faq: true }
];

const get = (path, accept = "text/html") =>
  fetch(new URL(path, origin), { headers: { Accept: accept }, redirect: "manual", signal: AbortSignal.timeout(30_000) });

const text = (html) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)].map((match) => match[1].replace(/&amp;/g, "&"));

const sitemap = await (await get("/sitemap.xml")).text();
const llms = await (await get("/llms.txt")).text();
const home = await (await get("/")).text();

const menu = home.match(/<ul class="lp-products-menu[\s\S]*?<\/ul>/)?.[0];
assert.ok(menu, "Home page has the Products menu");
assert.deepEqual(hrefs(menu), products.map((product) => product.path), "Products menu links to the four product pages, in order");

const localLinks = new Map();

for (const product of products) {
  const { path } = product;
  const response = await get(path);
  assert.equal(response.status, 200, path);
  const html = await response.text();

  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${path}: exactly one h1`);
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  assert.equal(canonical, `${canonicalOrigin}${path}`, `${path}: canonical`);
  assert.ok(html.match(/<meta\b[^>]*name="description"[^>]*content="[^"]{50,}"/), `${path}: meta description`);
  assert.ok(sitemap.includes(`<loc>${canonicalOrigin}${path}</loc>`), `${path}: in the sitemap`);
  assert.ok(llms.includes(`${canonicalOrigin}${path}`), `${path}: linked from llms.txt`);

  const ownMenu = html.match(/<ul class="lp-products-menu[\s\S]*?<\/ul>/)?.[0] ?? "";
  const current = ownMenu.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
  assert.ok(current.includes(`href="${path}"`), `${path}: marked as the current product in the menu`);

  const others = html.match(/<nav\b[^>]*aria-label="Other OpenWork products"[\s\S]*?<\/nav>/)?.[0];
  assert.ok(others, `${path}: links to the other products`);
  assert.deepEqual(
    hrefs(others).sort(),
    products.filter((other) => other.path !== path).map((other) => other.path).sort(),
    `${path}: the other three products, and not itself`
  );

  if (product.faq) {
    const schemas = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((match) => JSON.parse(match[1]));
    const faq = schemas.find((schema) => schema["@type"] === "FAQPage");
    assert.ok(faq?.mainEntity.length, `${path}: FAQ schema`);
    const visible = text(html);
    for (const question of faq.mainEntity) {
      assert.ok(visible.includes(question.name), `${path}: FAQ question is visible: ${question.name}`);
      assert.ok(visible.includes(question.acceptedAnswer.text), `${path}: FAQ answer is visible: ${question.name}`);
    }
  }

  const markdownResponse = await get(path, "text/markdown");
  assert.equal(markdownResponse.status, 200, `${path}: Markdown for agents`);
  assert.match(markdownResponse.headers.get("content-type"), /^text\/markdown/);
  assert.match(markdownResponse.headers.get("vary"), /Accept/i);
  assert.ok((await markdownResponse.text()).startsWith("# "), `${path}: Markdown starts with a heading`);

  for (const href of hrefs(html)) {
    // Docs are proxied to Mintlify and checked by check-agent-links.mjs.
    if (!href.startsWith("/") || href.startsWith("/docs")) continue;
    const target = href.split("#")[0];
    if (!localLinks.has(target)) localLinks.set(target, path);
  }
}

for (const [target, from] of localLinks) {
  const response = await get(target);
  assert.ok(response.status >= 200 && response.status < 400, `${from}: link to ${target} answers ${response.status}`);
}

console.log(`ok ${products.length} product pages, ${localLinks.size} local links`);
