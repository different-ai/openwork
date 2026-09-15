import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDocument, workspaceImageUrl } from "./document-markdown.ts";

const HOME = "/Users/me/.config/openwork/coworkers/nova";

function html(text: string): string {
  return renderDocument(text, HOME).blocks.map((block) => block.html).join("");
}

test("raw HTML is escaped instead of executed", () => {
  const raw = html("Text <script>alert(1)</script> and <img src=x onerror=alert(1)> end\n");
  assert.ok(!raw.includes("<script>"), raw);
  assert.ok(raw.includes("&lt;script&gt;"), raw);
  assert.ok(!raw.includes("<img"), raw);
});

test("doc: links open another document, anchors stay, other schemes fall back to their text, web links keep their href", () => {
  const links = html("See [the plan](doc:launch-plan), [above](#doc-timeline), [site](https://example.com \"Ex\"), [bad](javascript:alert(1)), [file](file:///etc/passwd).\n");
  assert.match(links, /<a href="doc:launch-plan" data-doc="launch-plan" class="doc-link">the plan<\/a>/);
  assert.match(links, /<a href="#doc-timeline">above<\/a>/);
  assert.match(links, /<a href="https:\/\/example.com" title="Ex">site<\/a>/);
  assert.ok(!links.includes("javascript:"), links);
  assert.ok(!links.includes("file:///etc"), links);
  assert.match(links, /, bad, file\.<\/p>/);
});

test("images load only from inside the coworker home", () => {
  assert.equal(workspaceImageUrl("workspace/chart.png", HOME), `file://${HOME}/workspace/chart.png`);
  assert.equal(workspaceImageUrl("./workspace/a b.png", HOME), `file://${HOME}/workspace/a%20b.png`);
  assert.equal(workspaceImageUrl("../other/secret.png", HOME), null);
  assert.equal(workspaceImageUrl("/etc/passwd", HOME), null);
  assert.equal(workspaceImageUrl("https://example.com/pixel.gif", HOME), null);
  assert.equal(workspaceImageUrl("workspace/chart.png", ""), null);
  const rendered = html("![Chart](workspace/chart.png)\n\n![Pixel](https://example.com/p.gif)\n");
  assert.match(rendered, new RegExp(`<img src="file://${HOME}/workspace/chart.png" alt="Chart" loading="lazy">`));
  assert.doesNotMatch(rendered, /<img[^>]+\bsrc="https?:/);
  assert.match(rendered, /<span class="doc-image-missing">Pixel<\/span>/);
});

test("the injected sanitizer sees every block", () => {
  const seen: string[] = [];
  const rendered = renderDocument("A\n\n```\ncode\n```\n\nB\n", HOME, (value) => {
    seen.push(value);
    return "<clean>";
  });
  assert.equal(seen.length, 3);
  assert.deepEqual(rendered.blocks.map((block) => block.html), ["<clean>", "<clean>", "<clean>"]);
});
