#!/usr/bin/env node
// Read-only check against a running landing build. No connected services or actions.
// node scripts/check-guides.mjs --base-url http://localhost:3081
import assert from "node:assert/strict";

const index = process.argv.indexOf("--base-url");
const base = index >= 0 ? process.argv[index + 1] : undefined;
if (!base) throw new Error("Pass --base-url for the running landing build.");
const origin = new URL(base);
const canonicalOrigin = "https://openworklabs.com";
const get = (path, accept = "text/html") => fetch(new URL(path, origin), {
  headers: { Accept: accept },
  signal: AbortSignal.timeout(30_000)
});
const sitemap = await get("/sitemap.xml");
assert.equal(sitemap.status, 200);
const paths = [...(await sitemap.text()).matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map((match) => new URL(match[1]).pathname)
  .filter((path) => path.startsWith("/guides/"));
assert.ok(paths.length > 0, "Guide pages must be discoverable in the sitemap");
assert.equal(new Set(paths).size, paths.length, "No duplicate guide URLs");
const indexResponse = await get("/guides");
assert.equal(indexResponse.status, 200);
const indexHtml = await indexResponse.text();
const llmsResponse = await get("/llms.txt");
assert.equal(llmsResponse.status, 200);
const llms = await llmsResponse.text();

for (const path of paths) {
  const response = await get(path);
  assert.equal(response.status, 200, path);
  const html = await response.text();
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1];
  assert.ok(heading, `${path}: a visible answer heading`);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${path}: exactly one h1`);
  const canonical = html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/)?.[1];
  assert.equal(canonical, `${canonicalOrigin}${path}`, `${path}: canonical`);
  assert.ok(indexHtml.includes(`href="${path}"`), `${path}: linked from guides index`);
  assert.ok(llms.includes(`${canonicalOrigin}${path}`), `${path}: linked from llms.txt`);

  const schemas = [...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  const article = schemas.find((schema) => schema["@type"] === "TechArticle");
  const faq = schemas.find((schema) => schema["@type"] === "FAQPage");
  assert.ok(article, `${path}: article schema`);
  assert.ok(faq?.mainEntity.length, `${path}: FAQ schema`);
  assert.equal(article.url, canonical);
  assert.ok(html.includes(`dateTime="${article.dateModified}"`), `${path}: visible freshness matches schema`);
  const markdownResponse = await get(path, "text/markdown");
  assert.equal(markdownResponse.status, 200);
  assert.match(markdownResponse.headers.get("content-type"), /^text\/markdown/);
  assert.match(markdownResponse.headers.get("vary"), /Accept/i);
  const markdown = await markdownResponse.text();
  assert.ok(markdown.startsWith(`# ${article.headline}\n`), `${path}: Markdown headline matches`);
  assert.ok(markdown.includes(article.abstract), `${path}: Markdown answer matches`);
  assert.ok(markdown.includes(article.dateModified), `${path}: Markdown freshness matches`);
  for (const question of faq.mainEntity) {
    assert.ok(markdown.includes(question.name), `${path}: FAQ question matches`);
    assert.ok(markdown.includes(question.acceptedAnswer.text), `${path}: FAQ answer matches`);
  }
  for (const match of html.matchAll(/href="(\/guides[^"?#]*)"/g)) {
    assert.ok(match[1] === "/guides" || paths.includes(match[1]), `${path}: no link to withheld guide ${match[1]}`);
  }
  console.log(`PASS ${path}: HTML, canonical, schema, Markdown, and discovery`);
}
const missing = "/guides/not-a-published-guide";
assert.equal((await get(missing)).status, 404);
assert.equal((await get(missing, "text/markdown")).status, 404);
const preferHtml = await get(paths[0], "text/html;q=1, text/markdown;q=0.5");
assert.match(preferHtml.headers.get("content-type"), /^text\/html/);
console.log(`PASS ${paths.length} guides; unknown routes 404 and Accept preference honored`);
