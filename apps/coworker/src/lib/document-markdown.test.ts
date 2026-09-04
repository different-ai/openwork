import assert from "node:assert/strict";
import { test } from "node:test";
import { TOC_MIN_SECTIONS, headingSlug, renderDocument, workspaceImageUrl } from "./document-markdown.ts";

const HOME = "/Users/me/.config/openwork/coworkers/nova";

function html(text: string): string {
  return renderDocument(text, HOME).blocks.map((block) => block.html).join("");
}

test("headings get stable, unique ids and three or more ## sections earn a table of contents", () => {
  const rendered = renderDocument("## Timeline\n\nx\n\n## Owners\n\ny\n\n## Timeline\n\nz\n\n### Detail\n\nw\n", HOME);
  assert.deepEqual(rendered.toc, [
    { id: "doc-timeline", text: "Timeline" },
    { id: "doc-owners", text: "Owners" },
    { id: "doc-timeline-2", text: "Timeline" },
  ]);
  const joined = rendered.blocks.map((block) => block.html).join("");
  assert.match(joined, /<h2 id="doc-timeline">Timeline<\/h2>/);
  assert.match(joined, /<h2 id="doc-timeline-2">Timeline<\/h2>/);
  assert.match(joined, /<h3 id="doc-detail">Detail<\/h3>/);
  assert.equal(renderDocument("## One\n\nx\n\n## Two\n\ny\n", HOME).toc.length, 0, `fewer than ${TOC_MIN_SECTIONS} sections: no table of contents`);
  assert.equal(headingSlug("Risks & mitigations: Q3!"), "risks-mitigations-q3");
  assert.equal(headingSlug("   "), "section");
});

test("code blocks come out as their own blocks with the language and raw text for Copy", () => {
  const rendered = renderDocument("Intro.\n\n```ts\nconst a = 1;\n```\n\nAfter.\n", HOME);
  assert.deepEqual(rendered.blocks.map((block) => block.kind), ["html", "code", "html"]);
  const code = rendered.blocks[1];
  assert.ok(code && code.kind === "code");
  assert.equal(code.lang, "ts");
  assert.equal(code.text, "const a = 1;");
  assert.match(code.html, /<pre><code class="language-ts">const a = 1;\n<\/code><\/pre>/);
});

test("tables and task lists render; callouts are marked; raw HTML is shown as text", () => {
  const table = html("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  assert.match(table, /<table>[\s\S]*<th>A<\/th>[\s\S]*<td>2<\/td>/);
  const tasks = html("- [x] Done\n- [ ] Not yet\n");
  assert.match(tasks, /<input checked="" disabled="" type="checkbox">/);
  assert.match(tasks, /<input disabled="" type="checkbox">/);
  const callout = html("> **Note:** this matters.\n\n> Just a quote.\n");
  assert.match(callout, /<blockquote class="doc-callout" data-callout="note">/);
  assert.match(callout, /<blockquote>\n<p>Just a quote\.<\/p>/);
  assert.match(html("> **Warning** careful\n"), /data-callout="warning"/);
  assert.match(html("> **Caution** careful\n"), /data-callout="warning"/);
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
  renderDocument("A\n\n```\ncode\n```\n\nB\n", HOME, (value) => {
    seen.push(value);
    return "<clean>";
  });
  assert.equal(seen.length, 3);
});
