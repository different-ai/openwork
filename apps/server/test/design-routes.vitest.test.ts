import { expect, test } from "vitest";

import {
  extractOpenGraphMetadata,
  isPublicAddress,
  parseDesigneerIndex,
  referenceImageExtension,
  slugFromTitle,
} from "../src/routes/design.ts";

test("isPublicAddress rejects loopback, private and link-local ranges", () => {
  expect(isPublicAddress("127.0.0.1")).toBe(false);
  expect(isPublicAddress("10.1.2.3")).toBe(false);
  expect(isPublicAddress("172.16.0.1")).toBe(false);
  expect(isPublicAddress("172.31.255.255")).toBe(false);
  expect(isPublicAddress("172.32.0.1")).toBe(true);
  expect(isPublicAddress("192.168.1.1")).toBe(false);
  expect(isPublicAddress("169.254.1.1")).toBe(false);
  expect(isPublicAddress("100.64.0.1")).toBe(false);
  expect(isPublicAddress("224.0.0.1")).toBe(false);
  expect(isPublicAddress("0.0.0.0")).toBe(false);
  expect(isPublicAddress("::1")).toBe(false);
  expect(isPublicAddress("::")).toBe(false);
  expect(isPublicAddress("fd00::1")).toBe(false);
  expect(isPublicAddress("fe80::1")).toBe(false);
  expect(isPublicAddress("::ffff:127.0.0.1")).toBe(false);
  expect(isPublicAddress("::ffff:93.184.216.34")).toBe(true);
  expect(isPublicAddress("93.184.216.34")).toBe(true);
  expect(isPublicAddress("8.8.8.8")).toBe(true);
  expect(isPublicAddress("not-an-ip")).toBe(false);
});

test("extractOpenGraphMetadata reads og:image and og:title with relative resolution", () => {
  const html = `<!doctype html><html><head>
    <title>Fallback Title</title>
    <meta property="og:image" content="/cdn/screen-123.png">
    <meta property="og:title" content="Unsplash hero shot">
  </head></html>`;
  const metadata = extractOpenGraphMetadata(html, "https://designeer.xyz/finds/some-1");
  expect(metadata.imageUrl).toBe("https://designeer.xyz/cdn/screen-123.png");
  expect(metadata.title).toBe("Unsplash hero shot");
});

test("extractOpenGraphMetadata falls back to twitter:image and <title>", () => {
  const html = `<!doctype html><head><meta name="twitter:image" content="https://cdn.example.com/x.jpg"><title>Page</title></head>`;
  const metadata = extractOpenGraphMetadata(html, "https://example.com/");
  expect(metadata.imageUrl).toBe("https://cdn.example.com/x.jpg");
  expect(metadata.title).toBe("Page");
});

test("extractOpenGraphMetadata returns nulls without metadata and rejects malformed images", () => {
  expect(extractOpenGraphMetadata("<html></html>", "https://example.com/").imageUrl).toBeNull();
  const broken = extractOpenGraphMetadata('<meta property="og:image" content="http://">', "https://example.com/");
  expect(broken.imageUrl).toBeNull();
});

test("referenceImageExtension prefers the content type then the URL path", () => {
  expect(referenceImageExtension("image/webp; charset=x", new URL("https://cdn/x.bin"))).toBe(".webp");
  expect(referenceImageExtension(null, new URL("https://cdn/a/b.JPEG?v=2"))).toBe(".jpg");
  expect(referenceImageExtension("application/octet-stream", new URL("https://cdn/pic.svg"))).toBe(".svg");
  expect(referenceImageExtension(null, new URL("https://cdn/no-ext"))).toBe(".png");
});

test("slugFromTitle keeps a bounded filesystem-safe stem", () => {
  expect(slugFromTitle("Hola, Mundo! — UI", "fallback")).toBe("hola-mundo-ui");
  expect(slugFromTitle(null, "example.com")).toBe("example-com");
  expect(slugFromTitle("x".repeat(200), "fallback").length).toBeLessThanOrEqual(60);
});

test("parseDesigneerIndex extracts finds, deduplicates and keeps the cursor", () => {
  const markdown = `## Latest finds

- [Find by Shivani](https://designeer.xyz/finds/shivanimatla-2115108611869573161) - built a digital sketchbook
- [Find by Damir Sokolovsky](/finds/heydamir-2115063463063998736) - Unslopping a vibecoded dashboard
- [Find by Damir Sokolovsky](/finds/heydamir-2115063463063998736) - repeated entry
- [Collections](/inspiration)

[Next page](https://designeer.xyz/index.md?cursor=eyJ2IjoxfQ%3D%3D)
`;
  const parsed = parseDesigneerIndex(markdown);
  expect(parsed.items).toHaveLength(2);
  expect(parsed.items[0]).toEqual({
    title: "Find by Shivani",
    url: "https://designeer.xyz/finds/shivanimatla-2115108611869573161",
    author: "Shivani",
    description: "built a digital sketchbook",
  });
  expect(parsed.items[1]?.url).toBe("https://designeer.xyz/finds/heydamir-2115063463063998736");
  expect(parsed.nextCursor).toBe("eyJ2IjoxfQ==");
});

test("parseDesigneerIndex returns no cursor when the page ends", () => {
  const parsed = parseDesigneerIndex("- [Find by A](/finds/a-1) - algo\n");
  expect(parsed.items).toHaveLength(1);
  expect(parsed.nextCursor).toBeNull();
});
