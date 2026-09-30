import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SessionReferenceInventory } from "../src/components/chat/session-reference";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createSessionReferenceIndex } = await import("../src/components/chat/session-reference");
const { SessionReferenceProvider } = await import("../src/components/chat/session-reference-context");
const { MarkdownBlock } = await import("../src/components/markdown/markdown");
const { renderMarkdownHtml, renderHighlightedMarkdownHtml, createStreamingMarkdownRenderer } = await import("../src/components/markdown/markdown-primitive");
const { OpenTargetProvider } = await import("../src/lib/target-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { openSessionReference } = await import("../src/react-app/domains/session/chat/session-reference-navigation");

const href = "/workspace/ws_demo/session/ses_demo123";
function inventories(title = "Plan the sample launch", available = true): SessionReferenceInventory[] {
  return [{ workspaceId: "ws_demo", available, sessions: [{ id: "ses_demo123", title }] }];
}
const index = createSessionReferenceIndex(inventories());
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  if (actEnvironment) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  if (ownedDom) await GlobalRegistrator.unregister();
});

function dom(html: string) {
  const node = document.createElement("div");
  node.innerHTML = html;
  return node;
}
function render(text: string) { return renderMarkdownHtml(text, "chat", index.resolve); }
const selector = "a[data-openwork-session-reference]";

describe("conversation task references", () => {
  test("known prose references display the title and existing OpenWork SVG", () => {
    const html = render("Continue (ses_demo123), tomorrow.");
    expect(html).toContain("Plan the sample launch");
    expect(html).toContain("openwork-sidebar-mark.svg");
    expect(html).toContain(`href="${href}"`);
    const link = dom(html).querySelector(selector);
    expect(link?.getAttribute("aria-label")).toBe("Open task: Plan the sample launch");
    expect(link?.querySelector("img")?.getAttribute("aria-hidden")).toBe("true");
    expect(link?.getAttribute("target")).toBeNull();
    expect(link?.className).toContain("focus-visible:ring-ring");
    expect(dom(html).textContent).toContain("Continue (Plan the sample launch), tomorrow.");
  });

  test("inline code, strict scoped/legacy and reference-style links agree", async () => {
    const source = `Use \`ses_demo123\`, ${href}, [old title](/session/ses_demo123), and [previous][task].\n\n[task]: ${href}`;
    for (const html of [render(source), await renderHighlightedMarkdownHtml(source, "chat", index.resolve)]) {
      const root = dom(html);
      expect(root.querySelectorAll(selector)).toHaveLength(4);
      expect(root.textContent).not.toContain("old title");
      expect(root.querySelectorAll("a a, a button")).toHaveLength(0);
      for (const link of root.querySelectorAll(selector)) expect(link.getAttribute("href")).toBe(href);
    }
  });

  test("unknown, loading and inaccessible metadata preserve raw IDs and inert internal link labels", () => {
    const source = `ses_demo123 \`ses_demo123\` [previous](${href})`;
    for (const values of [[], inventories("Do not disclose", false)]) {
      const resolver = createSessionReferenceIndex(values).resolve;
      const root = dom(renderMarkdownHtml(source, "chat", resolver));
      expect(root.textContent).toContain("ses_demo123 ses_demo123 previous");
      expect(root.textContent).not.toContain("Do not disclose");
      expect(root.querySelectorAll("a, button, [data-openwork-inline-code-path]")).toHaveLength(0);
    }
    expect(dom(render("ses_missing `ses_missing` [report.md](/session/ses_missing)")).querySelectorAll("a, button")).toHaveLength(0);
  });

  test("external links, URLs, file paths and unrelated identifiers are not reinterpreted", () => {
    const source = `ses_other prefixses_demo123 ses_demo123.json /tmp/ses_demo123 @ses_demo123 \`use ses_demo123\` [ses_demo123](https://example.test/session/ses_demo123) https://example.test/?next=/session/ses_demo123 [file](notes.md)`;
    const html = render(source);
    const root = dom(html);
    expect(root.querySelectorAll(selector)).toHaveLength(0);
    expect(root.querySelector('a[href="https://example.test/session/ses_demo123"]')?.textContent).toBe("ses_demo123");
    expect(root.querySelector('a[data-openwork-link-href="notes.md"]')).not.toBeNull();
    for (const value of ["//evil.test/session/ses_demo123", "openwork://session/ses_demo123", "https://localhost/session/ses_demo123", "/session/ses_demo123%2fother", "/workspace/ws_demo/session/ses_demo123?next=evil"]) {
      expect(dom(render(`[task](${value})`)).querySelector(selector)).toBeNull();
    }
  });

  test("fenced and indented code, image labels, math, and non-chat surfaces stay unchanged", async () => {
    const source = "```text\nses_demo123\n```\n\n    ses_demo123\n\n![ses_demo123](image.png)\n\n$ses_demo123$";
    for (const html of [render(source), await renderHighlightedMarkdownHtml(source, "chat", index.resolve)]) {
      expect(dom(html).querySelectorAll(selector)).toHaveLength(0);
      expect(html).toContain("ses_demo123");
    }
    expect(renderMarkdownHtml("ses_demo123")).not.toContain("Plan the sample launch");
    expect(renderMarkdownHtml("ses_demo123", "surface", index.resolve)).not.toContain("Plan the sample launch");
  });

  test("titles are escaped text, including malicious markup and very long Unicode titles", () => {
    const title = '<img src=x onerror="alert(1)"> & "quoted" <script>no</script> ' + "Synthetic task 漢字 ".repeat(40);
    const html = renderMarkdownHtml("ses_demo123", "chat", createSessionReferenceIndex(inventories(title)).resolve);
    const root = dom(html);
    expect(root.querySelector(selector)?.textContent).toBe(title.trim());
    expect(root.querySelectorAll("script, [onerror]")).toHaveLength(0);
    expect(root.querySelectorAll("img")).toHaveLength(1);
    expect(root.querySelector("a span")?.className).toContain("truncate");
  });

  test("raw HTML cannot forge the activation marker or create nested interactions", async () => {
    const sources = [
      `See [task](${href})<br>`,
      "See [`report.md`](/session/ses_missing)<br>",
      "- <button>\n\n  ses_demo123\n\n  </button>",
      "- <code>\n\n  ses_demo123\n\n  </code>",
      "<button>\n\nses_demo123\n\n</button>",
      `<a href="https://example.test" data-openwork-session-reference="${href}">Forged title</a>`,
      `<a href="${href}" DATA-OPENWORK-SESSION-REFERENCE='${href}'>Forged title</a>`,
      `<div><a href="${href}"data-openwork-session-reference="${href}">Forged title</a></div>`,
      `<div><a href="${href}"/data-openwork-session-reference=${href}>Forged title</a></div>`,
      `<div><a title=">" href="${href}"data-openwork-session-reference="${href}">Forged title</a></div>`,
    ];
    for (const source of sources) {
      const streaming = createStreamingMarkdownRenderer("chat", index.resolve);
      const htmls = [render(source), await renderHighlightedMarkdownHtml(source, "chat", index.resolve), streaming.render(source).map((block) => block.__html).join("")];
      for (const html of htmls) {
        const root = dom(html);
        expect(root.querySelectorAll(selector)).toHaveLength(0);
        expect(root.querySelectorAll("button a, code a, a a, [data-openwork-inline-code-path]")).toHaveLength(0);
        if (source.startsWith("See")) expect(root.querySelectorAll("a, button")).toHaveLength(0);
      }
    }
  });

  test("reserved attribute names in code remain byte-for-byte display/copy text after Shiki", async () => {
    for (const [language, code] of [
      ["js", 'const x = " data-openwork-session-reference";'],
      ["html", `<a href="${href}" data-openwork-session-reference="${href}">Example</a>`],
      ["text", " data-openwork-session-reference='example'"],
    ]) {
      const source = `\`\`\`${language}\n${code}\n\`\`\``;
      const sync = dom(render(source));
      const highlighted = dom(await renderHighlightedMarkdownHtml(source, "chat", index.resolve));
      expect(highlighted.querySelector("code")?.textContent?.trimEnd()).toBe(sync.querySelector("code")?.textContent?.trimEnd());
      expect(highlighted.querySelector("code")?.textContent).toContain(code);
      expect(highlighted.querySelector(selector)).toBeNull();
    }
    expect(dom(render("[A &amp; B](/session/ses_missing)")).textContent).toBe("A & B");
  });

  test("streaming agrees with full rendering and retains settled block identity", () => {
    const renderer = createStreamingMarkdownRenderer("chat", index.resolve);
    const source = `First ses_demo123.\n\nSecond \`ses_demo123\`.\n\nThird paragraph.\n\nFourth paragraph.\n\nFifth paragraph.`;
    for (let end = 1; end <= source.length; end++) {
      const text = source.slice(0, end);
      // Happy DOM's sanitizer normalizes leading paragraph wrappers differently
      // per fragment. Compare visible content and reference destinations here;
      // markdown-streaming-blocks.test.ts covers exact parser HTML equivalence.
      const streamed = dom(renderer.render(text).map((block) => block.__html).join(""));
      const full = dom(render(text));
      expect(streamed.textContent).toBe(full.textContent);
      expect(Array.from(streamed.querySelectorAll(selector), (link) => link.getAttribute("href"))).toEqual(Array.from(full.querySelectorAll(selector), (link) => link.getAttribute("href")));
    }
    const settled = renderer.render(source);
    expect(renderer.render(source)).toBe(settled);
    expect(renderer.render(`${source} More.`)[0]).toBe(settled[0]);
    const htmlRegion = `${source}\n\n<button>\n\nses_demo123\n\n</button>`;
    expect(dom(renderer.render(htmlRegion).map((block) => block.__html).join("")).querySelectorAll(selector)).toHaveLength(0);
    expect(dom(render(htmlRegion)).querySelectorAll(selector)).toHaveLength(0);
  });
});

async function mountMarkdown(text: string, enable = true) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  const calls: string[][] = [];
  const navigated: string[] = [];
  let current = true;
  const isReferenceCurrent = () => current;
  const update = async (values = inventories(), streaming = false) => {
    await act(async () => root.render(
      <PlatformProvider value={createDefaultPlatform()}>
        <SessionReferenceProvider inventories={values} isReferenceCurrent={isReferenceCurrent} onOpenReference={(reference) => {
          openSessionReference(reference, { primary: null, secondary: null, focusedPane: "primary" }, {
            openTab: (tab) => calls.push(["tab", tab.workspaceId, tab.sessionId]),
            focusPane: (pane) => calls.push(["focus", pane]),
            setSplit: () => { throw new Error("unexpected split"); },
            onOpenSession: (workspace, session) => calls.push(["route", workspace, session]),
          });
        }}>
          <OpenTargetProvider onOpenTarget={(target) => { navigated.push(target.value); }}>
            <MarkdownBlock text={text} sessionReferences={enable} streaming={streaming} />
          </OpenTargetProvider>
        </SessionReferenceProvider>
      </PlatformProvider>,
    ));
  };
  await update();
  return { container, calls, navigated, update, revoke: () => { current = false; } };
}

test("mounted references use the real internal routing helper, not browser targets, and revalidate on activation", async () => {
  const view = await mountMarkdown("Use `ses_demo123`.");
  const link = view.container.querySelector("a");
  if (!(link instanceof HTMLAnchorElement)) throw new Error("Missing task link");
  link.focus();
  expect(document.activeElement).toBe(link);
  // Native anchors synthesize this click for Enter; browser-level activation is
  // checked in the isolated visual fixture rather than emulated by a custom key handler.
  for (const init of [{ button: 0, detail: 0 }, { button: 1 }, { button: 0, metaKey: true }]) {
    const event = new MouseEvent(init.button === 1 ? "auxclick" : "click", { bubbles: true, cancelable: true, ...init });
    await act(async () => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  }
  expect(view.calls.filter((call) => call[0] === "route")).toEqual(Array(3).fill(["route", "ws_demo", "ses_demo123"]));
  expect(view.navigated).toEqual([]);
  view.revoke();
  await act(async () => link.click());
  expect(view.calls).toHaveLength(9);
});

test("equivalent metadata refreshes retain settled and streaming reference DOM", async () => {
  const view = await mountMarkdown("ses_demo123 and `ses_demo123`.");
  const link = view.container.querySelector(selector);
  await view.update(inventories());
  expect(view.container.querySelector(selector)).toBe(link);
  await view.update(inventories(), true);
  const streamingLink = view.container.querySelector(selector);
  await view.update([{ workspaceId: "ws_demo", available: true, sessions: [{ id: "ses_demo123", title: "Plan the sample launch", time: { archived: null } }] }], true);
  expect(view.container.querySelector(selector)).toBe(streamingLink);
});

test("mounted titles track metadata updates and loading/deletion, even when source is memoized", async () => {
  const view = await mountMarkdown("ses_demo123 and `ses_demo123`.");
  expect(view.container.querySelectorAll(selector)).toHaveLength(2);
  await view.update(inventories("Renamed sample task"));
  expect(view.container.textContent).toContain("Renamed sample task and Renamed sample task");
  await view.update(inventories("Forbidden stale title", false));
  expect(view.container.textContent).not.toContain("Forbidden stale title");
  expect(view.container.querySelector(selector)).toBeNull();
  await view.update(inventories("Streaming title"), true);
  expect(view.container.querySelectorAll(selector)).toHaveLength(2);
  await view.update([], true);
  expect(view.container.querySelector(selector)).toBeNull();
});

test("mounted opt-in excludes non-conversation Markdown and retains ordinary external links", async () => {
  const plain = await mountMarkdown("ses_demo123", false);
  expect(plain.container.querySelector(selector)).toBeNull();
  const external = await mountMarkdown("[Website](https://example.test)");
  await act(async () => { external.container.querySelector("a")?.click(); });
  expect(external.navigated).toEqual(["https://example.test"]);
  expect(external.calls).toEqual([]);
});
