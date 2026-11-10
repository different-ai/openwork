/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AssistantProse } from "../src/components/markdown/assistant-prose";
import { copyAssistantProseSelection, serializeAssistantProseRange, serializeAssistantMessageRange } from "../src/components/markdown/assistant-prose-clipboard";
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

const separator = '<p style="margin:0"><br></p>';
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
  test("paragraph → list → paragraph: zero margins and exactly one separator per top-level boundary", () => {
    const data = result('<div><p class="my-3" style="font:13px system-ui;color:red">Intro</p></div><div><ul class="list-disc"><li><p>One</p></li><li><p>Two</p></li></ul></div><div><p><strong>Expected:</strong> Result</p></div>');
    expect(data.html).toBe('<p style="margin:0">Intro</p>' + separator + '<ul style="margin:0"><li style="margin:0"><p style="margin:0">One</p></li><li style="margin:0"><p style="margin:0">Two</p></li></ul>' + separator + '<p style="margin:0"><strong>Expected:</strong> Result</p>');
    expect(data.text).toBe("Intro\n\n• One\n• Two\n\nExpected: Result");
    expect(data.html.split(separator)).toHaveLength(3);
    expect(data.html).not.toMatch(/class=|font|color|data-openwork/);
  });
  test("consecutive paragraphs have structural spacing, not a margin heuristic", () => {
    const data = result('<p>First</p><p>Second<br>continued</p><p>Third</p>');
    expect(data.text).toBe("First\n\nSecond\ncontinued\n\nThird");
    expect(data.html.split(separator)).toHaveLength(3);
  });
  test("nested and ordered lists preserve items and numbering", () => {
    const data = result('<ol start="3"><li><p>Parent</p><ul><li>Child</li><li><em>Next</em></li></ul></li><li>Last</li></ol>');
    expect(data.text).toBe("3. Parent\n  • Child\n  • Next\n4. Last");
    expect(data.html).toContain('<ol style="margin:0" start="3">');
    expect(data.html).not.toContain(separator);
  });
  test("partial ordered list starts at the selected source item", () => {
    const root = prose('<ol start="3"><li>First</li><li>Second</li><li>Third</li></ol>');
    const range = document.createRange();
    const second = text(root, 'li:nth-child(2)');
    range.setStart(second, 2); range.setEnd(second, second.length);
    const data = serializeAssistantProseRange(root, range);
    expect(data?.text).toBe("4. cond");
    expect(data?.html).toBe('<ol style="margin:0" start="4"><li style="margin:0">cond</li></ol>');
  });
  test("partial inline selection preserves its semantic ancestors and excludes unselected words", () => {
    const root = prose('<p>Hello <strong>brave <em>new</em></strong> world</p>');
    const range = document.createRange();
    range.setStart(text(root, 'strong'), 2); range.setEnd(text(root, 'em'), 3);
    expect(serializeAssistantProseRange(root, range)).toEqual({ html: '<p style="margin:0"><strong>ave <em>new</em></strong></p>', text: 'ave new' });
  });
  test("links retain href and emphasis, but no favicon or private/presentation attributes", () => {
    const data = result('<p><a href="https://example.com/docs?a=1&amp;b=2" class="link" target="_blank" rel="noreferrer" data-openwork-link-href="private"><img src="https://example.com/favicon" alt="" aria-hidden="true"><strong>Guide</strong></a> and <em>italic</em>.</p>');
    expect(data.html).toBe('<p style="margin:0"><a href="https://example.com/docs?a=1&amp;b=2"><strong>Guide</strong></a> and <em>italic</em>.</p>');
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
    expect(data.html).toBe('<pre style="margin:0"><code>  x &lt; y\n\n\tend\n</code></pre>' + separator + '<p style="margin:0">After</p>');
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
    expect(data.html).toContain('<table style="margin:0"><thead><tr><th>A</th><th>B</th></tr></thead>');
    expect(data.html.split(separator)).toHaveLength(2);
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
    expect(data?.html).toContain('<blockquote style="margin:0">');
    expect(data?.text).toContain('Expected: gap');
  });
  test.each([1, 2, 3, 4, 5, 6])("h%s becomes a bold paragraph without disabling surrounding copy", level => {
    const data = result(`<h${level}>Thread <em>label</em></h${level}><ul><li>Item</li></ul><p><strong>Expected:</strong> gap</p>`);
    expect(data.html).toBe('<p style="margin:0"><strong>Thread <em>label</em></strong></p>' + separator + '<ul style="margin:0"><li style="margin:0">Item</li></ul>' + separator + '<p style="margin:0"><strong>Expected:</strong> gap</p>');
    expect(data.text).toBe('Thread label\n\n• Item\n\nExpected: gap');
  });
  test("horizontal rules are a single structural boundary, not extra empty blocks", () => {
    const data = result('<p>First</p><hr><hr><p>After</p>');
    expect(data.html).toBe('<p style="margin:0">First</p>' + separator + '<p style="margin:0">After</p>');
    expect(data.text).toBe('First\n\nAfter');
  });
  test("strike and blockquotes remain semantic", () => {
    const data = result('<p><del>Old</del> new</p><blockquote><p>Quoted <em>word</em></p><p>Next</p></blockquote>');
    expect(data.html).toContain('<s>Old</s>');
    expect(data.html).toContain('<blockquote style="margin:0"><p style="margin:0">Quoted <em>word</em></p>' + separator + '<p style="margin:0">Next</p></blockquote>');
    expect(data.text).toBe('Old new\n\n> Quoted word\n> \n> Next');
  });
  test.each(['javascript:alert(1)', 'ftp://example.com/file', 'file:///tmp/report.pdf', '/tmp/report.pdf', '#section', 'https://bad host', ''])('nonportable href degrades only that label: %s', href => {
    const data = result(`<p>Before <a href="${href}"><em>Label</em></a> and <a href="https://example.com">Web</a></p><p>After</p>`);
    expect(data.html).toContain('Before <em>Label</em> and <a href="https://example.com">Web</a>');
    expect(data.text).toBe('Before Label and Web (https://example.com)\n\nAfter');
  });
  test.each(['mailto:user@example.com', 'tel:+15555550100'])('safe non-web href stays a link: %s', href => {
    expect(result(`<p><a href="${href}">Label</a></p>`).html).toContain(`href="${href}"`);
  });
  test("file-chip icon and Open with control are omitted; inline paths retain code", () => {
    const data = result('<p>File <span><a href="/workspace/report.pdf" data-openwork-link-href="/workspace/report.pdf"><svg><path></path></svg>report.pdf</a><button data-openwork-link-chevron="/workspace/report.pdf" aria-label="Open with"><svg></svg></button></span>, <code data-openwork-inline-code-path="/tmp/file.txt" role="button">file.txt</code>, <span data-openwork-directory-path="/tmp">folder</span>.</p><p>After</p>');
    expect(data.html).toBe('<p style="margin:0">File report.pdf, <code>file.txt</code>, folder.</p>' + separator + '<p style="margin:0">After</p>');
    expect(data.text).toBe('File report.pdf, file.txt, folder.\n\nAfter');
  });
  test("partial file label preserves only selected words", () => {
    const root = prose('<p><a href="file:///tmp/file" data-openwork-link-href="file:///tmp/file"><svg></svg>report.pdf</a></p>');
    const range = document.createRange(); const label = root.querySelector('a')!.lastChild!; range.setStart(label, 2); range.setEnd(label, 6);
    expect(serializeAssistantProseRange(root, range)).toEqual({html:'<p style="margin:0">port</p>', text:'port'});
  });
});

describe("message-level prose mapping", () => {
  function message() { return prose('<div data-assistant-reply-prose><p>First <em>answer</em></p></div><section><h2>Tool</h2><input value="private"><p>Reasoning/tool output</p></section><div data-assistant-reply-prose><p>Last <a href="https://example.com">link</a></p></div>'); }
  test("prose → activity → prose serializes prose only", () => {
    const root = message(); const range = document.createRange(); range.setStart(text(root, '[data-assistant-reply-prose] p'), 2); range.setEnd(text(root, 'a'), 3);
    expect(serializeAssistantMessageRange(root, range)).toEqual({html:'<p style="margin:0">rst <em>answer</em></p>' + separator + '<p style="margin:0">Last <a href="https://example.com">lin</a></p>',text:'rst answer\n\nLast lin (https://example.com)'});
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
    expect(data.html).toBe('<p style="margin:0">First <em>part</em></p>' + separator + '<p style="margin:0">Second</p>');
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
