import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { markdownBlocks, sameToken, WorkbotMarkdown } from "../../../packages/workbot-ui/src/markdown";

/** An answer as the elements it renders, without their styling. */
const shape = (text: string) => renderToStaticMarkup(<WorkbotMarkdown text={text} />).replace(/ class="[^"]*"/g, "");
const bullet = '<span aria-hidden="true">•</span>';
const link = (label: string) => `<a href="https://example.com/docs" target="_blank" rel="noreferrer noopener">${label}</a>`;

test("an answer is read as one document: what depends on lines far apart keeps its shape", () => {
  // A loose list keeps its paragraphs, a numbered one its numbers, and an unfinished fence is code to the end.
  assert.equal(shape("- one\n\n- two\n\nAfter"), `<div><ul><li>${bullet}<span><p>one</p></span></li><li>${bullet}<span><p>two</p></span></li></ul><p>After</p></div>`);
  assert.equal(shape("3. third\n4. fourth\n   - child"), `<div><ol><li><span aria-hidden="true">3.</span><span><span>third</span></span></li><li><span aria-hidden="true">4.</span><span><span>fourth</span><ul><li>${bullet}<span><span>child</span></span></li></ul></span></li></ol></div>`);
  assert.equal(shape("Text\n\n```js\nlet a = 1;\n\nstill code"), "<div><p>Text</p><pre><code>let a = 1;\n\nstill code</code></pre></div>");
  assert.equal(shape("| A | B |\n|---|---|\n| 1 | **2** |"), "<div><div><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table></div></div>");
  // A link defined at the end reaches the blocks above it.
  assert.equal(shape("See [the docs][d] first.\n\n- and [d] here\n\n[d]: https://example.com/docs"), `<div><p>See ${link("the docs")} first.</p><ul><li>${bullet}<span><span>and ${link("d")} here</span></span></li></ul></div>`);
  // An anchor left open in one block stops the address in the next from becoming a link.
  assert.equal(shape('<a href="https://x.test">open\n\nhttps://example.com'), "<div><p>&lt;a href=&quot;https://x.test&quot;&gt;open</p><p>https://example.com</p></div>");
});

test("a reply being written re-renders only the block it is writing", () => {
  const reply = [
    "Here is the plan for **next week**, with a [link](https://example.com/plan).",
    "1. Collect the numbers\n   - revenue\n   - churn\n2. Draft the summary",
    "| Week | Done |\n|------|------|\n| 1 | yes |",
    "```sql\nselect 1;\n\nselect 2;\n```",
    "> Figures are estimates.",
    "That covers it.",
  ].join("\n\n");
  let previous = markdownBlocks("");
  let rendered = 0;
  for (let end = 1; end <= reply.length; end += 1) {
    const next = markdownBlocks(reply.slice(0, end));
    // A block re-renders when its token reads differently from the one last rendered in its place (MarkdownBlock).
    const changed = next.flatMap((token, index) => (sameToken(previous[index], token) ? [] : [index]));
    assert.ok(changed.every((index) => index >= previous.length - 2), `finished blocks stay as rendered at character ${end}`);
    rendered += changed.length;
    previous = next;
  }
  assert.ok(previous.length >= 8, "the reply has many blocks by the end");
  assert.ok(rendered <= reply.length * 1.2, `about one block a frame, not every block (${rendered} over ${reply.length} frames)`);
});

test("a block is compared by everything it shows, not only its own text", () => {
  const alone = markdownBlocks("Hello\n\nhttps://example.com").at(-1);
  const underAnchor = markdownBlocks('<a href="https://x.test">open\n\nhttps://example.com').at(-1);
  assert.equal(alone?.raw, underAnchor?.raw);
  assert.equal(sameToken(alone, underAnchor), false, "the same text reads differently under an open anchor");
  assert.equal(sameToken(markdownBlocks("See [d]\n\n[d]: https://example.com/docs")[0], markdownBlocks("See [d]")[0]), false, "a link's definition changes the block that uses it");
  assert.equal(sameToken(markdownBlocks("- a\n- b\n\nNext")[0], markdownBlocks("- a\n- b\n\nNext one")[0]), true);
});
