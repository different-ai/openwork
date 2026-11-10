/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AssistantProse } from "../src/components/markdown/assistant-prose";
import { copyAssistantProseSelection, joinAssistantProseClipboard, serializeAssistantProseRange, serializeAssistantMessageRange } from "../src/components/markdown/assistant-prose-clipboard";
import { FEATURES } from "../../../packages/features/src/registry";

const ownedDom = !GlobalRegistrator.isRegistered;
let createRoot: typeof import("react-dom/client")["createRoot"];
let reactRoot: Root | undefined;
beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  createRoot = (await import("react-dom/client")).createRoot;
});
afterEach(async () => {
  if (reactRoot) await act(async () => reactRoot?.unmount());
  reactRoot = undefined;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  mock.restore();
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });

function prose(html: string) {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}
function all(root: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(root);
  return range;
}
function text(root: Element, selector: string) {
  const node = root.querySelector(selector)?.firstChild;
  if (!(node instanceof Text)) throw new Error("Fixture must have a text node");
  return node;
}
function select(range: Range) {
  const selection = document.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}
function copyEvent(target: EventTarget | null) {
  const data = new Map<string, string>();
  const order: string[] = [];
  let prevented = false;
  return {
    data, order,
    get prevented() { return prevented; },
    event: {
      target, defaultPrevented: false,
      clipboardData: { setData: (format: string, value: string) => { order.push(format); data.set(format, value); } },
      preventDefault: () => { order.push("preventDefault"); prevented = true; },
    },
  };
}

function result(html: string) {
  const root = prose(html);
  const data = serializeAssistantProseRange(root, all(root));
  expect(data).not.toBeNull();
  if (!data) throw new Error("Expected portable data");
  return data;
}

describe("semantic selected prose and structural spacing", () => {
  test("paragraph → list → paragraph preserves blocks without presentation or padding", () => {
    const data = result('<div><p class="my-3" style="font:13px system-ui;color:red">Intro</p></div><div><ul class="list-disc"><li><p>One</p></li><li><p>Two</p></li></ul></div><div><p><strong>Expected:</strong> Result</p></div>');
    expect(data.html).toBe('<p>Intro</p><ul><li><p>One</p></li><li><p>Two</p></li></ul><p><strong>Expected:</strong> Result</p>');
    expect(data.text).toBe("Intro\n\n• One\n• Two\n\nExpected: Result");
    expect(data.html).not.toMatch(/class=|style=|font|color|data-openwork|<p>\s*(?:<br>)?\s*<\/p>/);
  });
  test.each(['ul','ol'])("top-level %s needs no padding before the following paragraph", tag => {
    const data = result(`<${tag}><li>First<ul><li>Nested</li></ul></li><li>Workspace menu.</li></${tag}><p><strong>Expected:</strong> gap</p><p>After</p>`);
    expect(data.html).toBe(`<${tag}><li>First<ul><li>Nested</li></ul></li><li>Workspace menu.</li></${tag}><p><strong>Expected:</strong> gap</p><p>After</p>`);
    expect(data.text).toBe((tag==='ol'?'1. First\n  • Nested\n2. Workspace menu.':'• First\n  • Nested\n• Workspace menu.')+'\n\nExpected: gap\n\nAfter');
  });
  test("list-at-end has no extra trailing paragraphs; escaped list text is literal", () => {
    expect(result('<ul><li>Only</li></ul>').html).toBe('<ul><li>Only</li></ul>');
    expect(result('<p><code>&lt;/ul&gt;</code></p><p>Next</p>').html).toBe('<p><code>&lt;/ul&gt;</code></p><p>Next</p>');
  });
  test("list and paragraph concatenate across a prose-group boundary without padding", () => {
    const root = prose('<div data-assistant-reply-prose><ul><li>Workspace menu.</li></ul></div><section>Tool</section><div data-assistant-reply-prose><p><strong>Expected:</strong> gap</p></div>');
    const data = serializeAssistantMessageRange(root,all(root));
    expect(data?.html).toBe('<ul><li>Workspace menu.</li></ul><p><strong>Expected:</strong> gap</p>');
    expect(data?.text).toBe('• Workspace menu.\n\nExpected: gap');
  });
  test("consecutive paragraphs use semantic HTML and readable plain text breaks", () => {
    const data = result('<p>First</p><p>Second<br>continued</p><p>Third</p>');
    expect(data.text).toBe("First\n\nSecond\ncontinued\n\nThird");
    expect(data.html).toBe('<p>First</p><p>Second<br>continued</p><p>Third</p>');
  });
  test("nested and ordered lists preserve items and numbering", () => {
    const data = result('<ol start="3"><li><p>Parent</p><ul><li>Child</li><li><em>Next</em></li></ul></li><li>Last</li></ol>');
    expect(data.text).toBe("3. Parent\n  • Child\n  • Next\n4. Last");
    expect(data.html).toContain('<ol start="3">');
    expect(data.html).toBe('<ol start="3"><li><p>Parent</p><ul><li>Child</li><li><em>Next</em></li></ul></li><li>Last</li></ol>');
  });
  test("partial ordered list starts at the selected source item", () => {
    const root = prose('<ol start="3"><li>First</li><li>Second</li><li>Third</li></ol>');
    const range = document.createRange();
    const second = text(root, 'li:nth-child(2)');
    range.setStart(second, 2); range.setEnd(second, second.length);
    const data = serializeAssistantProseRange(root, range);
    expect(data?.text).toBe("4. cond");
    expect(data?.html).toBe('<ol start="4"><li>cond</li></ol>');
  });
  test("partial inline selection preserves its semantic ancestors and excludes unselected words", () => {
    const root = prose('<p>Hello <strong>brave <em>new</em></strong> world</p>');
    const range = document.createRange();
    range.setStart(text(root, 'strong'), 2); range.setEnd(text(root, 'em'), 3);
    expect(serializeAssistantProseRange(root, range)).toEqual({ html: '<p><strong>ave <em>new</em></strong></p>', text: 'ave new' });
  });
  test("links retain href and emphasis, but no favicon or private/presentation attributes", () => {
    const data = result('<p><a href="https://example.com/docs?a=1&amp;b=2" class="link" target="_blank" rel="noreferrer" data-openwork-link-href="private"><img src="https://example.com/favicon" alt="" aria-hidden="true"><strong>Guide</strong></a> and <em>italic</em>.</p>');
    expect(data.html).toBe('<p><a href="https://example.com/docs?a=1&amp;b=2"><strong>Guide</strong></a> and <em>italic</em>.</p>');
    expect(data.text).toBe('Guide (https://example.com/docs?a=1&b=2) and italic.');
  });
  test("bare links don't repeat the URL", () => {
    expect(result('<p><a href="https://example.com">https://example.com</a></p>').text).toBe('https://example.com');
  });
  test("partial link text still refers to the selected label and its destination", () => {
    const root = prose('<p><a href="https://example.com">Guide</a></p>');
    const range = document.createRange(); range.setStart(text(root, 'a'), 1); range.setEnd(text(root, 'a'), 4);
    expect(serializeAssistantProseRange(root, range)?.text).toBe('uid (https://example.com)');
  });
  test("code blocks preserve literal whitespace, strip highlighting and omit generated controls", () => {
    const data = result('<div data-openwork-code-block><button data-openwork-code-copy>Copy</button><button data-openwork-code-wrap>Wrap</button><div><pre class="shiki"><code><span style="color:red">  x &lt; y</span>\n\n\tend\n</code></pre></div></div><p>After</p>');
    expect(data.html).toBe('<pre><code>  x &lt; y\n\n\tend\n</code></pre><p>After</p>');
    expect(data.text).toBe('  x < y\n\n\tend\n\n\nAfter');
  });
  test("inline code retains whitespace and escapes literal markup", () => {
    const data = result('<p>Use <code>a  &lt;b&gt;</code>.</p>');
    expect(data.text).toBe('Use a  <b>.');
    expect(data.html).toContain('<code>a  &lt;b&gt;</code>');
  });
  test("whole tables are semantic HTML with a readable tab-separated fallback", () => {
    const data = result('<table class="table"><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table><p>After</p>');
    expect(data.text).toBe('A\tB\n1\t2\n\nAfter');
    expect(data.html).toContain('<table><thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(data.html).toBe('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table><p>After</p>');
  });
});

describe("review coverage conversions", () => {
  test("actual renderer, GitHub decoration and search highlights stay portable", async () => {
    const { renderMarkdownHtml } = await import('../src/components/markdown/markdown-primitive');
    const { decorateGitHubReferences } = await import('../src/components/markdown/github-references');
    const { applyTextHighlights } = await import('../src/components/markdown/text-highlights');
    const root = prose(renderMarkdownHtml('### Subject\n\nSee [PR](https://github.com/different-ai/openwork/pull/7203) and [file](/tmp/report.pdf).\n\n> Quoted *text*.\n\n~~Old~~ `report.txt`\n\n---\n\nExpected: gap'));
    decorateGitHubReferences(root); applyTextHighlights(root, 'text');
    expect(root.querySelector('svg[data-github-reference-glyph]')).not.toBeNull();
    expect(root.querySelector('mark[data-search-highlight]')).not.toBeNull();
    const data = serializeAssistantProseRange(root, all(root));
    expect(data).not.toBeNull(); expect(data?.html).not.toMatch(/svg|button|data-|class=|<mark/);
    expect(data?.html).toContain('<a href="https://github.com/different-ai/openwork/pull/7203">PR</a>');
    // This renderer/sanitizer fixture emits bare heading text; real h1–h6 nodes are covered below.
    expect(data?.text).toStartWith('Subject\n\n');
    expect(data?.html).toContain('<blockquote><p>Quoted <em>text</em>.</p></blockquote>');
    expect(data?.html).toContain('<hr>');
    expect(data?.text).toContain('> Quoted text.');
    expect(data?.text).toContain('Expected: gap');
  });
  test.each([1, 2, 3, 4, 5, 6])("h%s preserves its actual level and inline formatting", level => {
    const data = result(`<h${level} class="heading" style="margin:20px;font-size:30px;color:red" data-private="secret">Thread <em>label</em></h${level}><ul><li>Item</li></ul><p><strong>Expected:</strong> gap</p>`);
    expect(data.html).toBe(`<h${level}>Thread <em>label</em></h${level}><ul><li>Item</li></ul><p><strong>Expected:</strong> gap</p>`);
    expect(data.text).toBe('Thread label\n\n• Item\n\nExpected: gap');
  });
  test("horizontal rules retain semantic HTML and readable plain dividers, not padding", () => {
    const data = result('<p>First</p><hr><hr><p>After</p>');
    expect(data.html).toBe('<p>First</p><hr><hr><p>After</p>');
    expect(data.text).toBe('First\n\n---\n\n---\n\nAfter');
    expect(result('<hr>')).toEqual({ html: '<hr>', text: '---' });
  });
  test("strike and quote paragraphs stay semantic with quoted plain text boundaries", () => {
    const data = result('<p><del>Old</del> new</p><blockquote><p>Quoted <em>word</em></p><p>Next</p></blockquote>');
    expect(data.html).toBe('<p><s>Old</s> new</p><blockquote><p>Quoted <em>word</em></p><p>Next</p></blockquote>');
    expect(data.text).toBe('Old new\n\n> Quoted word\n>\n> Next');
  });
  test("quote toolbar is stripped while heading, paragraphs, nested quote and rule survive", () => {
    const data = result('<blockquote data-openwork-quote class="quote" style="color:red"><button data-openwork-quote-copy="private"><svg></svg>Copy</button>\n<h2>Quoted <strong>title</strong></h2>\n<p>First<br>continued</p>\n<blockquote><p>Nested</p><p>Again</p></blockquote>\n<hr>\n<p>Last <a href="https://example.com">link</a></p>\n</blockquote><p>Outside</p>');
    expect(data.html).toBe('<blockquote> <h2>Quoted <strong>title</strong></h2> <p>First<br>continued</p> <blockquote><p>Nested</p><p>Again</p></blockquote> <hr> <p>Last <a href="https://example.com">link</a></p> </blockquote><p>Outside</p>');
    expect(data.text).toBe('> Quoted title\n>\n> First\n> continued\n>\n> > Nested\n> >\n> > Again\n>\n> ---\n>\n> Last link (https://example.com)\n\nOutside');
    expect(data.html).not.toMatch(/button|svg|private|class=|style=|data-|<p>\s*(?:<br>)?\s*<\/p>/);
    const reparsed = document.createElement('div'); reparsed.innerHTML = data.html;
    expect(reparsed.innerHTML).toBe(data.html);
    expect(reparsed.querySelector('blockquote > h2 strong')?.textContent).toBe('title');
    expect(reparsed.querySelectorAll('blockquote > p')).toHaveLength(4);
  });
  test("quotes preserve spaces between inline siblings and literal code", () => {
    expect(result('<blockquote><em>One</em> <strong>two</strong></blockquote>')).toEqual({ html: '<blockquote><em>One</em> <strong>two</strong></blockquote>', text: '> One two' });
    const data = result('<blockquote><p>Code:</p><pre><code>  first\n\n\tlast</code></pre></blockquote>');
    expect(data.html).toBe('<blockquote><p>Code:</p><pre><code>  first\n\n\tlast</code></pre></blockquote>');
    expect(data.text).toBe('> Code:\n>\n>   first\n>\n> \tlast');
  });
  test("partial quote and heading selection keeps semantic ancestors and selected text only", () => {
    const root = prose('<blockquote><h4>Before <em>Heading</em></h4><p>Next paragraph</p></blockquote>');
    const range = document.createRange(); range.setStart(text(root, 'em'), 2); range.setEnd(text(root, 'p'), 4);
    expect(serializeAssistantProseRange(root, range)).toEqual({ html: '<blockquote><h4><em>ading</em></h4><p>Next</p></blockquote>', text: '> ading\n>\n> Next' });
  });
  test("headings and quotes remain valid in list items and table cells", () => {
    const html = '<ul><li><h3>Item</h3><blockquote><p>Quote</p></blockquote><p>After</p></li></ul><table><tbody><tr><td><h5>Cell</h5><blockquote><p>Quoted cell</p></blockquote></td></tr></tbody></table>';
    const data = result(html);
    expect(data.html).toBe(html);
    expect(data.text).toBe('• Item\n> Quote\nAfter\n\nCell\n> Quoted cell');
    const reparsed = document.createElement('div'); reparsed.innerHTML = data.html;
    expect(reparsed.innerHTML).toBe(html);
  });
  test.each(['javascript:alert(1)', 'ftp://example.com/file', '#section', 'https://bad host', ''])('nonportable href degrades only that label: %s', href => {
    const data = result(`<p>Before <a href="${href}"><em>Label</em></a> and <a href="https://example.com">Web</a></p><p>After</p>`);
    expect(data.html).toContain('Before <em>Label</em> and <a href="https://example.com">Web</a>');
    expect(data.text).toBe('Before Label and Web (https://example.com)\n\nAfter');
  });
  test.each(['file:///tmp/report.pdf','/tmp/report.pdf','notes/report.pdf'])('local destinations retain label and literal path: %s', path => {
    const data = result(`<p><a href="${path}"><em>Label</em></a></p>`);
    expect(data.html).toBe(`<p><em>Label</em> (<code>${path}</code>)</p>`);
    expect(data.text).toBe(`Label (${path})`);
  });
  test.each(['mailto:user@example.com', 'tel:+15555550100'])('safe non-web href stays a link: %s', href => {
    expect(result(`<p><a href="${href}">Label</a></p>`).html).toContain(`href="${href}"`);
  });
  test("local file label carries its path as written, never a contextual absolute expansion", () => {
    const data = result('<p>Local file: <span><a href="/Users/private/workspace/notes/copy-probe.md" data-openwork-link-href="notes/copy-probe.md"><svg></svg>Copy probe note</a><button data-openwork-link-chevron="notes/copy-probe.md" aria-label="Open with"><svg></svg></button></span>.</p>');
    expect(data.html).toBe('<p>Local file: Copy probe note (<code>notes/copy-probe.md</code>).</p>');
    expect(data.text).toBe('Local file: Copy probe note (notes/copy-probe.md).');
    expect(data.html).not.toContain('/Users/');
  });
  test.each(['copy-probe.md','notes/copy-probe.md'])('matching file label reduces to code path: %s', label => {
    const data = result(`<p><a href="notes/copy-probe.md" data-openwork-link-href="notes/copy-probe.md">${label}</a></p>`);
    expect(data).toEqual({html:'<p><code>notes/copy-probe.md</code></p>',text:'notes/copy-probe.md'});
  });
  test("encoded path remains exactly written even when filename comparison is decoded", () => {
    expect(result('<p><a href="./notes/my%20file.txt" data-openwork-link-href="./notes/my%20file.txt">my file.txt</a></p>')).toEqual({html:'<p><code>./notes/my%20file.txt</code></p>',text:'./notes/my%20file.txt'});
  });
  test("inline code preserves written path rather than its resolved metadata", () => {
    expect(result('<p><code data-openwork-inline-code-path="/Users/private/notes/file.txt">notes/file.txt</code></p>')).toEqual({html:'<p><code>notes/file.txt</code></p>',text:'notes/file.txt'});
  });
  test("file-chip icon and Open with control are omitted; inline paths retain code", () => {
    const data = result('<p>File <span><a href="/workspace/report.pdf" data-openwork-link-href="/workspace/report.pdf"><svg><path></path></svg>report.pdf</a><button data-openwork-link-chevron="/workspace/report.pdf" aria-label="Open with"><svg></svg></button></span>, <code data-openwork-inline-code-path="/tmp/file.txt" role="button">file.txt</code>, <span data-openwork-directory-path="/tmp">folder</span>.</p><p>After</p>');
    expect(data.html).toBe('<p>File <code>/workspace/report.pdf</code>, <code>file.txt</code>, folder.</p><p>After</p>');
    expect(data.text).toBe('File /workspace/report.pdf, file.txt, folder.\n\nAfter');
  });
  test("partial file label preserves selected words plus its source-written destination", () => {
    const root = prose('<p><a href="file:///tmp/file" data-openwork-link-href="file:///tmp/file"><svg></svg>report.pdf</a></p>');
    const range = document.createRange(); const label = root.querySelector('a')!.lastChild!; range.setStart(label, 2); range.setEnd(label, 6);
    expect(serializeAssistantProseRange(root, range)).toEqual({html:'<p>port (<code>file:///tmp/file</code>)</p>', text:'port (file:///tmp/file)'});
  });
});

describe("message-level prose mapping", () => {
  function message() { return prose('<div data-assistant-reply-prose><p>First <em>answer</em></p></div><section><h2>Tool</h2><input value="private"><p>Reasoning/tool output</p></section><div data-assistant-reply-prose><p>Last <a href="https://example.com">link</a></p></div>'); }
  test("prose → activity → prose serializes prose only", () => {
    const root = message(); const range = document.createRange(); range.setStart(text(root, '[data-assistant-reply-prose] p'), 2); range.setEnd(text(root, 'a'), 3);
    expect(serializeAssistantMessageRange(root, range)).toEqual({html:'<p>rst <em>answer</em></p><p>Last <a href="https://example.com">lin</a></p>',text:'rst answer\n\nLast lin (https://example.com)'});
  });
  test("cross-group headings, quotes, lists and rules keep semantics while omitting activity", () => {
    const root = prose('<div data-assistant-reply-prose><h1>Title</h1><blockquote><p>First</p><p>Second</p></blockquote></div><section><p>Private activity</p></section><div data-assistant-reply-prose><hr><ol start="4"><li>Next</li></ol><h6>End</h6></div>');
    expect(serializeAssistantMessageRange(root, all(root))).toEqual({
      html: '<h1>Title</h1><blockquote><p>First</p><p>Second</p></blockquote><hr><ol start="4"><li>Next</li></ol><h6>End</h6>',
      text: 'Title\n\n> First\n>\n> Second\n\n---\n\n4. Next\n\nEnd',
    });
  });
  test("clipboard join concatenates fragments without padding and plain text with blank lines", () => {
    expect(joinAssistantProseClipboard([])).toBeNull();
    const first = result('<h2>Title</h2><blockquote><p>Quoted</p></blockquote>');
    const second = result('<hr><p>After</p>');
    expect(joinAssistantProseClipboard([first, second])).toEqual({
      html: first.html + second.html,
      text: 'Title\n\n> Quoted\n\n---\n\nAfter',
    });
    expect(joinAssistantProseClipboard([{ html: '<p>Large</p>', text: 'x'.repeat(1_000_001) }])).toBeNull();
  });
  test("nested and activity-forged markers cannot duplicate or include activity", () => {
    const root = prose('<div data-assistant-reply-prose><p>First <span data-assistant-reply-prose>word</span></p></div><section><div data-assistant-reply-prose><p>Secret tool</p></div></section><div data-assistant-reply-prose><p>Last</p></div>');
    expect(serializeAssistantMessageRange(root, all(root))?.text).toBe('First word\n\nLast');
  });
  test.each(['hidden', 'aria-hidden="true"', 'style="display:none"'])("hidden prose roots stay native: %s", attribute => {
    const root = prose(`<div data-assistant-reply-prose ${attribute}><p>Hidden</p></div><div data-assistant-reply-prose><p>Last</p></div>`);
    expect(serializeAssistantMessageRange(root, all(root))).toBeNull();
  });
  test("textless unsupported prose between groups is not silently skipped", () => {
    const root = prose('<div data-assistant-reply-prose><p>First</p></div><section>Tool</section><div data-assistant-reply-prose><img src="https://example.com/content.png" alt="Important image"></div><div data-assistant-reply-prose><p>Last</p></div>');
    expect(serializeAssistantMessageRange(root, all(root))).toBeNull();
  });
  test("whole message selection never includes activity", () => {
    const root = message(); const data = serializeAssistantMessageRange(root, all(root)); expect(data?.text).toBe('First answer\n\nLast link (https://example.com)'); expect(data?.html).not.toMatch(/Tool|private|Reasoning/);
  });
  test("tool-only and tool endpoints stay native", () => {
    const root = message(); const range = document.createRange(); range.selectNodeContents(root.querySelector('section')!); expect(serializeAssistantMessageRange(root, range)).toBeNull();
    range.setStart(text(root, '[data-assistant-reply-prose] p'), 0); expect(serializeAssistantMessageRange(root, range)).toBeNull();
  });
  test("another reply and unsupported selected prose stay native", () => {
    const root = message(); const outside = prose('<p>Other reply</p>'); const range = all(root); range.setEnd(text(outside, 'p'), 3); expect(serializeAssistantMessageRange(root, range)).toBeNull();
    root.querySelector('[data-assistant-reply-prose]')!.innerHTML='<p><span class="katex">math</span></p>'; expect(serializeAssistantMessageRange(root, all(root))).toBeNull();
  });
  test("grouped React listener handles bubbled copy once", async () => {
    const host = document.createElement('div'); document.body.append(host); reactRoot = createRoot(host); const copied = mock(() => {});
    await act(async () => reactRoot?.render(<AssistantProse grouped enabled onCopied={copied}><div data-assistant-reply-prose><p>First</p></div><section>Activity</section><div data-assistant-reply-prose><p>Last</p></div></AssistantProse>));
    const root = host.firstElementChild as HTMLElement; select(all(root)); const c = copyEvent(root);
    const event = new Event('copy', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'clipboardData', {value:c.event.clipboardData}); root.querySelector('p')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(c.data.get('text/plain')).toBe('First\n\nLast'); expect(copied).toHaveBeenCalledTimes(1);
  });
});

describe("review regression cases", () => {
  test.each(['ul', 'ol'])("descendant-only %s selection keeps native copy rather than inventing an empty parent marker", tag => {
    const root = prose(`<${tag}><li>Parent<ul><li>Child</li></ul></li><li>Next</li></${tag}>`);
    const range = document.createRange(); range.selectNodeContents(root.querySelector('ul li ul li, ol li ul li')!);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
    range.setEnd(text(root, `${tag} > li:last-child`), 4);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
  });
  test("text-bearing divs preserve block boundaries", () => {
    const data = result('<div>First <em>part</em></div><div>Second</div>');
    expect(data.text).toBe('First part\n\nSecond');
    expect(data.html).toBe('<p>First <em>part</em></p><p>Second</p>');
  });
  test("paragraphs in a table cell retain text boundaries", () => {
    expect(result('<table><tbody><tr><td><p>First</p><p>Second</p></td><td>Other</td></tr></tbody></table>').text).toBe('First\nSecond\tOther');
  });
  test.each([
    '<a href="https://example.com"><p>First</p><p>Second</p></a>',
    '<div>Mixed <p>block</p> trailing</div>',
    '<ol reversed><li>First</li><li>Second</li></ol>',
    '<ol type="a"><li>First</li></ol>',
    '<ul><p>Not an item</p></ul>',
    '<li>Orphan item</li>',
  ])("ambiguous structure/numbering falls back: %s", html => {
    const root = prose(html); expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test.each(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 's', 'a', 'code', 'p'])("invalid block nesting inside %s stays native rather than emitting malformed HTML", tag => {
    // Construct directly: HTML parsers may repair invalid source before the serializer sees it.
    const root = prose(''); const outer = document.createElement(tag);
    const quote = document.createElement('blockquote'); quote.innerHTML = '<p>Nested block</p>';
    outer.append(quote); root.append(outer);
    expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test.each(['h2', 'p', 'ul', 'pre'])("invalid %s block nested in a heading stays native", tag => {
    const root = prose(''); const heading = document.createElement('h1');
    const block = document.createElement(tag); block.textContent = 'Nested'; heading.append(block); root.append(heading);
    expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test.each(['li', 'td', 'tr', 'thead'])("orphan %s inside a quote stays native", tag => {
    const root = prose(''); const quote = document.createElement('blockquote');
    const orphan = document.createElement(tag); orphan.textContent = 'Orphan'; quote.append(orphan); root.append(quote);
    expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test("copying a generated quote toolbar control stays native", () => {
    const root = prose('<blockquote data-openwork-quote><button data-openwork-quote-copy="private">Copy</button><p>Quote</p></blockquote>');
    const range = document.createRange(); range.selectNodeContents(root.querySelector('button')!);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
  });
  test("visually complete table text without enclosing table boundaries remains conservative", () => {
    const root = prose('<table><tbody><tr><td>First</td><td>Last</td></tr></tbody></table>');
    const range = document.createRange(); range.setStart(text(root, 'td'), 0); range.setEnd(text(root, 'td:last-child'), 4);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
  });
  test("multiple selection ranges remain native", () => {
    const root = prose('<p>Reply</p>');
    const selection = spyOn(document, 'getSelection').mockReturnValue({ rangeCount: 2, isCollapsed: false } as Selection);
    try {
      const c = copyEvent(root); expect(copyAssistantProseSelection(c.event, root, true)).toBe(false); expect(c.order).toEqual([]);
    } finally { selection.mockRestore(); }
  });
});

describe("conservative native fallback", () => {
  test("empty and collapsed selections", () => {
    const root = prose('<p>Hello</p>');
    const range = document.createRange(); range.setStart(text(root, 'p'), 2); range.collapse(true);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
    expect(serializeAssistantProseRange(prose(''), document.createRange())).toBeNull();
  });
  test("a selection leaving this prose root or crossing into tool output stays native", () => {
    const root = prose('<p>Reply</p>'); const outside = prose('<p>Tool output</p>');
    const range = document.createRange(); range.setStart(text(root, 'p'), 0); range.setEnd(text(outside, 'p'), 4);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
  });
  test.each([
    '<p>Before <span class="katex">math</span> after</p>',
    '<p><span data-mention="id">mention</span></p>',
    '<p><a href="/workspace/private" data-openwork-session-reference="private">Task</a></p>',
    '<p><img src="https://example.com/content.png" alt="Content image"></p>',
    '<p hidden>Hidden content</p>',
    '<p style="display:none">Hidden content</p>',
    '<p><span aria-hidden="true">Hidden content</span>Visible</p>',
    '<ul><li><input type="checkbox">Task</li></ul>',
  ])("unsupported/atomic content is not silently degraded: %s", html => {
    const root = prose(html);
    expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test("partial math and partial table cells stay native", () => {
    const root = prose('<p><span class="katex">formula</span></p><table><tbody><tr><td>Cell</td></tr></tbody></table>');
    for (const selector of ['.katex', 'td']) {
      const range = document.createRange(); range.setStart(text(root, selector), 1); range.setEnd(text(root, selector), 3);
      expect(serializeAssistantProseRange(root, range)).toBeNull();
    }
  });
  test("tables with spanning cells stay native instead of losing semantics", () => {
    const root = prose('<table><tbody><tr><td colspan="2">Cell</td></tr></tbody></table>');
    expect(serializeAssistantProseRange(root, all(root))).toBeNull();
  });
  test("copying a generated code toolbar control stays native", () => {
    const root = prose('<div data-openwork-code-block><button>Copy</button><pre><code>x</code></pre></div>');
    const range = document.createRange(); range.selectNodeContents(root.querySelector('button')!);
    expect(serializeAssistantProseRange(root, range)).toBeNull();
  });
});

describe("copy listener contract", () => {
  test("flag is declared off on both deployments", () => {
    expect(FEATURES.assistantProseClipboard.default).toBe(false);
    expect(FEATURES.assistantProseClipboard.deployments).toEqual(['cloud', 'self_hosted']);
  });
  test("writes both complete formats before canceling native copy", () => {
    const root = prose('<p>First</p><p>Second</p>'); select(all(root)); const c = copyEvent(root);
    expect(copyAssistantProseSelection(c.event, root, true)).toBe(true);
    expect(c.order).toEqual(['text/html', 'text/plain', 'preventDefault']);
    expect(c.data.get('text/plain')).toBe('First\n\nSecond');
    expect(c.prevented).toBe(true);
  });
  test("flag off, missing clipboard data, prior cancellation or no selection leave copy native", () => {
    const root = prose('<p>First</p>'); select(all(root));
    const off = copyEvent(root); expect(copyAssistantProseSelection(off.event, root, false)).toBe(false); expect(off.order).toEqual([]);
    const missing = { ...copyEvent(root).event, clipboardData: null };
    expect(copyAssistantProseSelection(missing, root, true)).toBe(false);
    const prior = copyEvent(root); prior.event.defaultPrevented = true;
    expect(copyAssistantProseSelection(prior.event, root, true)).toBe(false); expect(prior.order).toEqual([]);
    document.getSelection()?.removeAllRanges(); const empty = copyEvent(root);
    expect(copyAssistantProseSelection(empty.event, root, true)).toBe(false); expect(empty.prevented).toBe(false);
  });
  test("input/composer targets keep native copy", () => {
    const root = prose('<p>Reply</p><input value="private"><div contenteditable="true">Draft</div>');
    const range = document.createRange(); range.selectNodeContents(root.querySelector('p')!); select(range);
    for (const target of root.querySelectorAll('input,[contenteditable]')) {
      const c = copyEvent(target); expect(copyAssistantProseSelection(c.event, root, true)).toBe(false); expect(c.order).toEqual([]);
    }
  });
  test("range/serializer exceptions and clipboard write failures do not cancel native copy", () => {
    const root = prose('<p>Reply</p>'); const range = all(root); select(range);
    const fault = spyOn(range, 'intersectsNode').mockImplementation(() => { throw new Error('selection moved'); });
    const c = copyEvent(root); expect(copyAssistantProseSelection(c.event, root, true)).toBe(false); expect(c.order).toEqual([]); fault.mockRestore();
    const failed = copyEvent(root); failed.event.clipboardData.setData = () => { throw new Error('unavailable'); };
    expect(copyAssistantProseSelection(failed.event, root, true)).toBe(false); expect(failed.prevented).toBe(false);
  });
  test.each([false, true])("React prose wrapper gates real bubbled copy handling: enabled=%s", async enabled => {
    const host = document.createElement('div'); document.body.append(host); reactRoot = createRoot(host); const copied = mock(() => {});
    await act(async () => reactRoot?.render(<AssistantProse enabled={enabled} onCopied={copied}><p>Reply</p></AssistantProse>));
    const root = host.querySelector('[data-assistant-reply-prose]');
    if (!(root instanceof HTMLElement)) throw new Error('Missing wrapper');
    select(all(root)); const data = new Map<string, string>();
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (format: string, value: string) => data.set(format, value) } });
    root.querySelector('p')?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(enabled); expect(data.size).toBe(enabled ? 2 : 0); expect(copied).toHaveBeenCalledTimes(enabled ? 1 : 0);
  });
});
