import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { SITE } from "./content.ts";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

test("every URL-bearing file agrees with SITE.url", () => {
  const html = read("index.html");
  assert.ok(html.includes(`<link rel="canonical" href="${SITE.url}/" />`), "canonical");
  assert.ok(html.includes(`<meta property="og:url" content="${SITE.url}/" />`), "og:url");
  assert.ok(html.includes(`<meta property="og:image" content="${SITE.url}/og.png" />`), "og:image");
  assert.ok(html.includes(`<meta name="twitter:image" content="${SITE.url}/og.png" />`), "twitter:image");
  assert.ok(read("public/robots.txt").includes(`Sitemap: ${SITE.url}/sitemap.xml`), "robots sitemap");
  assert.ok(read("public/sitemap.xml").includes(`<loc>${SITE.url}/</loc>`), "sitemap home");
  assert.ok(read("public/sitemap.xml").includes(`<loc>${SITE.url}/start.md</loc>`), "sitemap start.md");
});

test("sharing metadata is complete and the OG image is a real 1200x630 PNG", () => {
  const html = read("index.html");
  for (const needle of [
    'property="og:title"',
    'property="og:description"',
    'property="og:image:width" content="1200"',
    'property="og:image:height" content="630"',
    'property="og:image:alt"',
    'name="twitter:card" content="summary_large_image"',
    'rel="apple-touch-icon"',
    'rel="manifest"',
    'application/ld+json',
  ]) {
    assert.ok(html.includes(needle), `index.html is missing ${needle}`);
  }
  const png = readFileSync(resolve(root, "public/og.png"));
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(png.readUInt32BE(16), 1200, "og.png width");
  assert.equal(png.readUInt32BE(20), 630, "og.png height");
});

test("structured data parses and describes a free macOS application built on OpenWork", () => {
  const html = read("index.html");
  const match = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "JSON-LD block present");
  const graph = JSON.parse(match![1]!) as { "@graph": Array<Record<string, unknown>> };
  const app = graph["@graph"].find((node) => node["@type"] === "SoftwareApplication");
  assert.ok(app);
  assert.equal(app.operatingSystem, "macOS");
  assert.equal(app.isAccessibleForFree, true);
  assert.equal((app.offers as { price: string }).price, "0");
  assert.equal(app.codeRepository, SITE.repository);
});

test("agent documents exist, are plain text, and never pipe remote scripts into a shell", () => {
  const start = read("public/start.md");
  const llms = read("public/llms.txt");
  assert.match(start, /^# Open Coworker Start/);
  assert.match(start, /Ask\s+before installing anything/);
  assert.match(start, /pnpm --filter @openwork\/coworker dev/);
  assert.match(start, /~\/.config\/openwork\/coworkers\//);
  assert.doesNotMatch(start, /curl[^\n]*\|\s*(ba)?sh/, "no curl | sh");
  assert.match(llms, /^# Open Coworker/);
  assert.match(llms, /\(\/start\.md\)/);
  assert.match(llms, new RegExp(SITE.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const manifest = JSON.parse(read("public/manifest.webmanifest")) as { name: string; icons: unknown[] };
  assert.equal(manifest.name, SITE.name);
  assert.ok(manifest.icons.length >= 2);
});
