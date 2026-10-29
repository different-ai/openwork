#!/usr/bin/env node
// Verify server-rendered governance pages, metadata, FAQ parity, links and crawler responses.
// Usage: pnpm check:shadow-ai --base-url http://localhost:3017
import assert from "node:assert/strict";

const args = process.argv.slice(2);
const index = args.indexOf("--base-url");
const baseUrl = index >= 0 ? args[index + 1] : process.env.LANDING_BASE_URL;
if (!baseUrl) {
  console.error("Usage: pnpm check:shadow-ai --base-url http://localhost:<port>");
  process.exit(2);
}
async function read(path, accept = "text/html") {
  const response = await fetch(new URL(path, baseUrl), { headers: { Accept: accept }, signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `${path} must return 200`);
  return { response, body: await response.text() };
}
const attribute = (tag, name) => tag?.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const decode = (text) => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">");
const plain = text => decode(text.replace(/<[^>]+>/g, "").replace(/<!--.*?-->/g, "")).trim();
const pages = [
  { path: "/shadow-ai", title: /Shadow AI governance.*OpenWork/, count: 10 },
  { path: "/ai-governance", title: /AI governance.*OpenWork/, count: 6 },
  { path: "/enterprise", title: /OpenWork Enterprise.*AI governance/, count: 6 }
];
const htmlPages = new Map();
for (const {path, title, count} of pages) {
  const { body: html } = await read(path);
  htmlPages.set(path, html);
  const metas = [...html.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => tag);
  const meta = key => metas.find(tag => attribute(tag, "name") === key || attribute(tag, "property") === key);
  const pageTitle = decode(html.match(/<title>(.*?)<\/title>/s)?.[1] ?? "");
  assert.match(pageTitle, title, `${path} title`);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, `${path}: exactly one H1`);
  assert.ok([...html.matchAll(/<h2\b/g)].length >= 5, `${path}: substantive sections`);
  for (const key of ["description", "og:title", "og:description", "og:image", "twitter:title", "twitter:description", "twitter:image"]) {
    assert.ok(attribute(meta(key), "content"), `${path}: ${key} is nonempty`);
  }
  assert.equal(decode(attribute(meta("og:title"), "content")), pageTitle);
  assert.equal(decode(attribute(meta("twitter:title"), "content")), pageTitle);
  assert.equal(attribute(meta("og:description"), "content"), attribute(meta("description"), "content"));
  assert.equal(attribute(meta("twitter:description"), "content"), attribute(meta("description"), "content"));
  assert.equal(attribute(meta("og:url"), "content"), `https://openworklabs.com${path}`);
  assert.equal(attribute(meta("twitter:card"), "content"), "summary_large_image");
  const canonical = [...html.matchAll(/<link\b[^>]*>/g)].find(([tag]) => attribute(tag, "rel") === "canonical")?.[0];
  assert.equal(attribute(canonical, "href"), `https://openworklabs.com${path}`);
  const schemas = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)].map(([, json]) => JSON.parse(json));
  const faq = schemas.find(schema => schema["@type"] === "FAQPage");
  assert.ok(faq, `${path}: FAQPage structured data`);
  assert.equal(faq.mainEntity.length, count);
  const questions = [...html.matchAll(/<summary\b[^>]*>(.*?)<\/summary>/gs)].map(([, summary]) => plain(summary.replace(/<span\b[^>]*>.*?<\/span>/gs, "").replace(/<svg\b.*?<\/svg>/gs, "")));
  assert.deepEqual(questions, faq.mainEntity.map(question => question.name), `${path}: visible FAQ questions match JSON-LD`);
  const answers = [...html.matchAll(/<details\b[^>]*>.*?<p\b[^>]*>(.*?)<\/p>.*?<\/details>/gs)].map(([, answer]) => plain(answer));
  assert.deepEqual(answers, faq.mainEntity.map(question => question.acceptedAnswer.text), `${path}: answers match JSON-LD`);
  for (const destination of pages.map(page => page.path).filter(destination => destination !== path)) {
    assert.ok(html.includes(`href="${destination}"`), `${path} links to ${destination}`);
  }
  assert.match(plain(html), /AWS Bedrock/);
  assert.match(plain(html), /in progress/);
  const { response, body: markdown } = await read(path, "text/markdown");
  assert.match(response.headers.get("content-type"), /text\/markdown/);
  assert.match(response.headers.get("vary"), /Accept/);
  assert.match(markdown, /^# /);
  assert.match(markdown, /AWS Bedrock/);
  assert.match(markdown, /does not automatically/);
  console.log(`PASS ${path}: SEO, headings, FAQ/JSON-LD parity, cross-links, crawler markdown`);
}
const { body: sitemap } = await read("/sitemap.xml", "application/xml");
for (const {path} of pages) assert.ok(sitemap.includes(`<loc>https://openworklabs.com${path}</loc>`));
const { body: home } = await read("/");
assert.match(home, /href="\/shadow-ai"/);
assert.match(home, /href="\/ai-governance"/);
assert.match(htmlPages.get("/enterprise"), /id="book"/);
const shadow = htmlPages.get("/shadow-ai");
for (const path of ["/enterprise", "/pricing", "/privacy", "/connect", "/guides/claude-code-codex-cursor"]) {
  assert.ok(shadow.includes(`href="${path}"`));
  await read(path);
}
const {body: llms} = await read("/llms.txt", "text/plain");
for (const {path} of pages) assert.ok(llms.includes(`https://openworklabs.com${path}`));
console.log("PASS: sitemap, llms.txt, incoming/outgoing links and booking anchor");
