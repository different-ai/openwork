import { describe, expect, test } from "bun:test";

import { renderMarkdownHtml } from "../src/components/markdown/markdown-primitive";

describe("chat markdown images", () => {
  test("an image keeps its link as a hidden fallback for when it cannot load", () => {
    const html = renderMarkdownHtml("![Greetings from California](https://upload.wikimedia.org/postcard.jpg)", "chat");
    const image = html.indexOf('<img src="https://upload.wikimedia.org/postcard.jpg"');
    const fallback = html.indexOf('<span data-openwork-image-fallback="" hidden>');
    const link = html.indexOf('href="https://upload.wikimedia.org/postcard.jpg"', fallback);

    expect(html).toContain('<span data-openwork-image=""><button type="button" data-openwork-image-preview=""');
    expect(image).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(image);
    expect(link).toBeGreaterThan(fallback);
    expect(html.indexOf(">Greetings from California</a>", link)).toBeGreaterThan(link);
  });

  test("remote prose still shows images only as links", () => {
    const html = renderMarkdownHtml("![chart](https://example.com/chart.png)", "remote");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/chart.png"');
  });
});
