import { describe, expect, test } from "bun:test";

import { MarkdownBlock, renderHighlightedMarkdownHtml, renderMarkdownHtml } from "../src/components/markdown/markdown";
import {
  codeWrapClassStates,
  renderHighlightedMarkdownHtml as renderPrimitiveHighlightedMarkdownHtml,
  renderMarkdownHtml as renderPrimitiveMarkdownHtml,
} from "../src/components/markdown/markdown-primitive";
import { textHighlightParts } from "../src/components/markdown/text-highlights";
import { enhanceNearViewport } from "../src/components/markdown/near-viewport";

const CODE = "const value = 1;\nconsole.log(value);";
const MARKDOWN = `\`\`\`ts\n${CODE}\n\`\`\``;

describe("markdown code blocks", () => {
  test("renders fallback code blocks with subtle theme-aware styling, copy, and word-wrap affordances", () => {
    const html = renderMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-openwork-code-block");
    expect(html).toContain("bg-gray-2/60");
    expect(html).toContain("data-openwork-code-copy");
    expect(html).toContain("data-openwork-code-copy-icon");
    expect(html).toContain("data-openwork-code-copy-check-icon");
    expect(html).toContain("data-openwork-code-wrap");
    expect(html).toContain("data-openwork-code-scroll");
    expect(html).toContain("h-7 w-7");
    expect(html).toContain('aria-label="Copy code block"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('title="Copy code block"');
    expect(html).toContain('aria-label="Enable word wrap"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('title="Enable word wrap"');
    expect(html).not.toContain(">Copy</span>");
    expect(html).toContain("pt-11");
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain(CODE);
    expect(html).toContain(CODE.split("\n")[0]);
    expect(html).toContain(CODE.split("\n")[1]);
  });

  test("maps word-wrap state to visual styles without changing the rendered code", () => {
    expect(codeWrapClassStates(false)).toEqual({
      "overflow-x-auto": true,
      "overflow-x-hidden": false,
      "whitespace-pre-wrap": false,
      "break-words": false,
    });
    expect(codeWrapClassStates(true)).toEqual({
      "overflow-x-auto": false,
      "overflow-x-hidden": true,
      "whitespace-pre-wrap": true,
      "break-words": true,
    });
  });

  test("renders highlighted code blocks with the same copy affordance and dual Shiki themes", async () => {
    const html = await renderHighlightedMarkdownHtml(MARKDOWN);

    expect(html).toContain("data-openwork-code-block");
    expect(html).toContain("data-openwork-shiki");
    expect(html).toContain("data-openwork-code-copy");
    expect(html).toContain("data-openwork-code-copy-icon");
    expect(html).toContain("data-openwork-code-copy-check-icon");
    expect(html).toContain("data-openwork-code-wrap");
    expect(html).toContain("data-openwork-code-scroll");
    expect(html).toContain("--shiki-dark");
    expect(html).toContain("github-light");
    expect(html).toContain("github-dark");
  });

  test("renders surface code blocks without chat-only copy controls", async () => {
    const fallbackHtml = renderPrimitiveMarkdownHtml(MARKDOWN, "surface");
    expect(fallbackHtml).toContain("border-dls-border/70");
    expect(fallbackHtml).toContain("bg-gray-1/80");
    expect(fallbackHtml).toContain('class="language-ts"');
    expect(fallbackHtml).not.toContain("data-openwork-code-copy");

    const highlightedHtml = await renderPrimitiveHighlightedMarkdownHtml(MARKDOWN, "surface");
    expect(highlightedHtml).toContain("data-openwork-shiki");
    expect(highlightedHtml).toContain("github-light");
    expect(highlightedHtml).not.toContain("github-dark");
    expect(highlightedHtml).not.toContain("data-openwork-code-copy");
  });
});

describe("markdown safety and links", () => {
  test("blocks unsafe markdown link targets and strips raw HTML from surface markdown", () => {
    const html = renderMarkdownHtml(`[bad](javascript:alert(1))`);

    expect(html).toContain('href="#"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(`<img src="x" onerror="alert(1)"><script>alert(1)</script>`, "surface");
    expect(surfaceHtml).not.toContain("onerror");
    expect(surfaceHtml).not.toContain("<script");
  });

  test("keeps chat file link actions separate from simple surface links", () => {
    const markdown = `[Open docs](./docs/readme.md) and [OpenWork](https://openworklabs.com)`;
    const chatHtml = renderMarkdownHtml(markdown);
    expect(chatHtml).toContain("data-openwork-link-chevron");
    expect(chatHtml).toContain("data-openwork-link-href");
    expect(chatHtml).toContain('href="https://openworklabs.com"');

    const surfaceHtml = renderPrimitiveMarkdownHtml(markdown, "surface");
    expect(surfaceHtml).not.toContain("data-openwork-link-chevron");
    expect(surfaceHtml).not.toContain("data-openwork-link-href");
    expect(surfaceHtml).toContain('href="./docs/readme.md"');
    expect(surfaceHtml).toContain('href="https://openworklabs.com"');
  });

  test("marks chat inline file paths as keyboard-accessible artifact links", () => {
    const chatHtml = renderMarkdownHtml("Open `apps/app/src/main.tsx` and inspect `status`.");
    expect(chatHtml).toContain('data-openwork-inline-code-path="apps/app/src/main.tsx"');
    expect(chatHtml).toContain('role="button"');
    expect(chatHtml).toContain('tabindex="0"');
    expect(chatHtml).not.toContain('data-openwork-inline-code-path="status"');

    const surfaceHtml = renderPrimitiveMarkdownHtml("Open `apps/app/src/main.tsx`.", "surface");
    expect(surfaceHtml).not.toContain("data-openwork-inline-code-path");
  });

  test("does not mark unsafe or parent-relative inline paths", () => {
    const html = renderMarkdownHtml("Skip `../secrets/config.ts`, `https://example.com/file.ts`, and `a | b.ts`.");
    expect(html).not.toContain("data-openwork-inline-code-path");
  });
});

describe("markdown text highlighting", () => {
  test("splits matching text without changing the original casing", () => {
    expect(textHighlightParts("Markdown makes marks in markdown.", "MARK")).toEqual([
      { text: "Mark", highlighted: true },
      { text: "down makes ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "s in ", highlighted: false },
      { text: "mark", highlighted: true },
      { text: "down.", highlighted: false },
    ]);
  });

  test("treats highlight queries as literal text", () => {
    expect(textHighlightParts("Find a+b and a+b again", "a+b")).toEqual([
      { text: "Find ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " and ", highlighted: false },
      { text: "a+b", highlighted: true },
      { text: " again", highlighted: false },
    ]);
  });
});

test("optional formatting waits for the reading viewport, runs once, and cancels on navigation", async () => {
  const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register();
  const originalObserver = globalThis.IntersectionObserver;
  const observers: TestObserver[] = [];
  class TestObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "320px 0px";
    readonly thresholds = [0];
    readonly scrollMargin = "0px";
    pending = new Set<Element>();
    constructor(readonly callback: IntersectionObserverCallback, options: IntersectionObserverInit) {
      expect(options.rootMargin).toBe(this.rootMargin);
      observers.push(this);
    }
    observe(element: Element) { this.pending.add(element); }
    unobserve(element: Element) { this.pending.delete(element); }
    disconnect() { this.pending.clear(); }
    takeRecords() { return []; }
    notify(target: Element, isIntersecting: boolean) {
      const rect = target.getBoundingClientRect();
      this.callback([{ target, isIntersecting, time: 0, rootBounds: null,
        boundingClientRect: rect, intersectionRect: rect, intersectionRatio: Number(isIntersecting) }], this);
    }
  }
  Reflect.set(globalThis, "IntersectionObserver", TestObserver);
  try {
    const recent = document.createElement("div");
    const older = document.createElement("div");
    recent.innerHTML = renderMarkdownHtml(MARKDOWN);
    older.innerHTML = renderMarkdownHtml(MARKDOWN);
    const enhanced: HTMLElement[] = [];
    const stop = enhanceNearViewport([recent, older], (element) => enhanced.push(element));
    expect(recent.textContent).toContain(CODE);
    expect(older.textContent).toContain(CODE);
    expect(enhanced).toEqual([]);
    const observer = observers[0];
    observer.notify(older, false);
    observer.notify(recent, true);
    observer.notify(recent, true);
    expect(enhanced).toEqual([recent]);
    expect(observer.pending.has(older)).toBe(true);
    observer.notify(older, true);
    expect(enhanced).toEqual([recent, older]);
    expect(observer.pending.size).toBe(0);
    stop();

    const cancel = enhanceNearViewport([older], (element) => enhanced.push(element));
    cancel();
    observers[1].notify(older, true);
    expect(enhanced).toHaveLength(2);

    Reflect.set(globalThis, "IntersectionObserver", undefined);
    enhanceNearViewport([recent], (element) => enhanced.push(element));
    expect(enhanced).toEqual([recent, older, recent]);

    // Streaming and settled documents use different keyed DOM roots. The
    // observer must follow the committed root, including an initially empty one.
    Reflect.set(globalThis, "IntersectionObserver", TestObserver);
    const { act, createElement } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const previousActEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      for (const initial of [{ text: MARKDOWN, streaming: true }, { text: "", streaming: false }]) {
        await act(async () => root.render(createElement(MarkdownBlock, initial)));
        const previousRoot = host.firstElementChild;
        await act(async () => root.render(createElement(MarkdownBlock, { text: MARKDOWN, streaming: false })));
        const settledRoot = host.firstElementChild;
        if (!(settledRoot instanceof HTMLElement)) throw new Error("Missing settled markdown root");
        expect(settledRoot).not.toBe(previousRoot);
        const observer = observers.at(-1);
        if (!observer) throw new Error("Missing settled-document observer");
        expect(observer.pending.has(settledRoot)).toBe(true);
        await act(async () => observer.notify(settledRoot, true));
        for (let attempt = 0; attempt < 100 && !settledRoot.querySelector("pre.shiki"); attempt++) {
          await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
        }
        expect(settledRoot.querySelector("pre.shiki")).not.toBeNull();
        await act(async () => root.render(null));
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
    }
  } finally {
    Reflect.set(globalThis, "IntersectionObserver", originalObserver);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});
