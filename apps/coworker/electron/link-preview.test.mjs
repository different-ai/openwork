import assert from "node:assert/strict";
import test from "node:test";
import { createLinkPreviews, pageMetadata, publicUrl } from "./link-preview.mjs";

const publicDns = async () => [{ address: "93.184.216.34" }];

test("link previews only read public http(s) hosts", async () => {
  for (const url of ["http://localhost:3000/", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.2/", "http://[::1]/",
    "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "https://user:pass@example.com/", "http://printer.local/"]) {
    assert.equal(await publicUrl(url, publicDns), null, url);
  }
  assert.equal(await publicUrl("https://intranet.example/", async () => [{ address: "10.1.2.3" }]), null, "a public name resolving to a private address");
  assert.equal((await publicUrl("https://example.com/page", publicDns))?.hostname, "example.com");
});

test("page metadata prefers Open Graph and falls back to the title", () => {
  const url = new URL("https://www.example.com/articles/jev");
  const og = pageMetadata(`<head><title>Ignored</title><meta property="og:title" content="Jev &amp; typed outputs">
    <meta name="description" content="Decision model">
    <meta property="og:site_name" content="TypeSafe"><meta property="og:image" content="/cover.png"></head>`, url);
  assert.deepEqual(og, { title: "Jev & typed outputs", description: "Decision model", siteName: "TypeSafe", image: "https://www.example.com/cover.png", video: false });
  assert.equal(pageMetadata('<meta property="og:type" content="video.other"><meta property="og:title" content="Clip">', url).video, true);
  const plain = pageMetadata("<title> Plain page </title>", url);
  assert.deepEqual(plain, { title: "Plain page", description: "", siteName: "example.com", image: "", video: false });
});

test("a redirect to a private address is not followed, and images come back inline", async () => {
  const pages = {
    "https://example.com/": new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    "https://example.com/ok": new Response('<meta property="og:title" content="Hello"><meta property="og:image" content="https://example.com/i.png">', { headers: { "content-type": "text/html" } }),
    "https://example.com/i.png": new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "3" } }),
  };
  const fetched = [];
  const previews = createLinkPreviews({ resolve: publicDns, fetchImpl: async (url) => { fetched.push(url); return pages[url]; } });
  assert.equal(await previews.read("https://example.com/"), null);
  assert.ok(!fetched.some((url) => url.includes("127.0.0.1")), "the private redirect target is never requested");
  const preview = await previews.read("https://example.com/ok");
  assert.deepEqual(preview, { url: "https://example.com/ok", title: "Hello", description: "", siteName: "example.com", image: "data:image/png;base64,AQID", video: false });
  const requests = fetched.length;
  await previews.read("https://example.com/ok");
  assert.equal(fetched.length, requests, "a repeated preview is served from the cache");
});
