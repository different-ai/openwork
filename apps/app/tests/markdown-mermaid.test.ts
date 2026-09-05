import { describe, expect, test } from "bun:test";

import {
  renderHighlightedMarkdownHtml,
  renderMarkdownHtml,
  type MarkdownPresentation,
} from "../src/components/markdown/markdown-primitive";
import { getArtifactType, isMarkdownPreviewSupported } from "../src/lib/artifacts";
import {
  guardMermaidSource,
  isSafeMermaidSvgReference,
  MERMAID_LIMITS,
  mermaidConfigForTheme,
  normalizeCssEscapes,
  renderMermaidSource,
  type MermaidRuntime,
} from "../src/components/markdown/mermaid";

const SOURCE = "flowchart LR\n  Start[Start] --> Finish[Finish]";
const MARKDOWN = `\`\`\`mermaid\n${SOURCE}\n\`\`\``;

describe("Mermaid Markdown placeholders", () => {
  test("parses Mermaid fences into inert source fallbacks for chat and artifact surfaces", async () => {
    const presentations: MarkdownPresentation[] = ["chat", "surface"];
    for (const presentation of presentations) {
      const fallback = renderMarkdownHtml(MARKDOWN, presentation);
      const highlighted = await renderHighlightedMarkdownHtml(MARKDOWN, presentation);

      for (const html of [fallback, highlighted]) {
        expect(html).toContain("data-openwork-mermaid");
        expect(html).toContain("data-openwork-mermaid-source");
        expect(html).toContain("data-openwork-mermaid-view=\"rendered\"");
        expect(html).toContain("data-openwork-mermaid-download");
        expect(html).toContain("Start[Start] --&gt; Finish[Finish]");
        expect(html).not.toContain("<svg");
      }
    }
  });

  test("leaves non-Mermaid fences on the existing code path", () => {
    const html = renderMarkdownHtml("```ts\nconst diagram = false;\n```");
    expect(html).toContain("data-openwork-code-block");
    expect(html).not.toContain("data-openwork-mermaid");
  });

  test("classifies standalone Mermaid source as a Markdown artifact", () => {
    expect(getArtifactType("diagrams/architecture.mmd")).toBe("markdown");
    expect(isMarkdownPreviewSupported("mmd")).toBe(true);
  });
});

describe("Mermaid rendering boundaries", () => {
  test("guards source bytes, nodes, edges, and semicolon-separated statements before loading Mermaid", async () => {
    expect(guardMermaidSource("x".repeat(MERMAID_LIMITS.maxSourceBytes + 1))).toMatchObject({ ok: false, reason: "size" });
    const complex = [
      "flowchart TD",
      ...Array.from({ length: MERMAID_LIMITS.maxNodes + 1 }, (_, index) => `N${index}[Node ${index}]`),
    ].join("\n");
    expect(guardMermaidSource(complex)).toMatchObject({ ok: false, reason: "complexity" });
    const statementHeavy = [
      "flowchart TD",
      ...Array.from({ length: MERMAID_LIMITS.maxStatements }, (_, index) => `statement${index}`),
    ].join(";");
    expect(guardMermaidSource(statementHeavy)).toMatchObject({ ok: false, reason: "complexity" });

    let loads = 0;
    const guarded = await renderMermaidSource(complex, "light", {
      loadRuntime: async () => {
        loads += 1;
        throw new Error("must not load");
      },
    });
    expect(guarded).toEqual({ status: "source", reason: "complexity" });
    expect(await renderMermaidSource(statementHeavy, "light", {
      loadRuntime: async () => {
        loads += 1;
        throw new Error("must not load");
      },
    })).toEqual({ status: "source", reason: "complexity" });
    expect(loads).toBe(0);
  });

  test("rejects directives and resource syntax before loading Mermaid", async () => {
    const unsafeSources = [
      "%%{init: {'theme': 'dark'}}%%\nflowchart LR\nA --> B",
      "%%{config: {'htmlLabels': true}}%%\nflowchart LR\nA --> B",
      "---\nconfig:\n  theme: dark\n---\nflowchart LR\nA --> B",
      "flowchart LR; A --> B; click A callback",
      "flowchart LR\nA[https://example.com/image.svg]",
      "flowchart LR\nA[data:image/svg+xml;base64,AAAA]",
      "flowchart LR\nA[blob:payload]",
      "flowchart LR\nA[file:///tmp/payload]",
      "flowchart LR\nA[javascript:alert(1)]",
      "flowchart LR\nA[ftp://example.com/payload]",
      "flowchart LR\nA[//example.com/payload]",
      String.raw`flowchart LR; A[u\72l(https://example.com/payload)]`,
      String.raw`flowchart LR; A[u\72l(#local-resource)]`,
      String.raw`flowchart LR; A[\68 ttps://example.com/payload]`,
      String.raw`flowchart LR; cl\69 ck A callback`,
      String.raw`%%{\69 nit: {'theme': 'dark'}}%%; flowchart LR; A --> B`,
      "flowchart LR; A[@import 'theme.css']",
      "flowchart LR; A[src=local.svg]",
      "flowchart LR; A[h/**/ttps://example.com/payload]",
    ];
    let loads = 0;

    for (const source of unsafeSources) {
      expect(guardMermaidSource(source)).toMatchObject({ ok: false, reason: "unsafe" });
      expect(await renderMermaidSource(source, "light", {
        loadRuntime: async () => {
          loads += 1;
          throw new Error("must not load");
        },
      })).toEqual({ status: "source", reason: "unsafe" });
    }
    expect(loads).toBe(0);
  });

  test("keeps source for malformed, unavailable, and timed-out renders", async () => {
    const malformedRuntime: MermaidRuntime = {
      initialize: () => undefined,
      render: async () => { throw new Error("bad syntax"); },
    };
    await expect(renderMermaidSource("not-a-diagram", "light", {
      loadRuntime: async () => malformedRuntime,
    })).resolves.toEqual({ status: "source", reason: "invalid" });

    await expect(renderMermaidSource(SOURCE, "light", {
      loadRuntime: async () => { throw new Error("chunk unavailable"); },
    })).resolves.toEqual({ status: "source", reason: "unavailable" });

    const stalledRuntime: MermaidRuntime = {
      initialize: () => undefined,
      render: () => new Promise<{ svg: string }>(() => undefined),
    };
    await expect(renderMermaidSource(SOURCE, "light", {
      loadRuntime: async () => stalledRuntime,
      timeoutMs: 1,
    })).resolves.toEqual({ status: "source", reason: "timeout" });
  });

  test("uses strict theme-specific config with HTML labels disabled", () => {
    const light = mermaidConfigForTheme("light");
    const dark = mermaidConfigForTheme("dark");

    expect(light).toMatchObject({ securityLevel: "strict", htmlLabels: false, startOnLoad: false, theme: "default" });
    expect(light.flowchart).toMatchObject({ htmlLabels: false });
    expect(light.secure).toContain("securityLevel");
    expect(light.secure).toContain("htmlLabels");
    expect(dark.theme).toBe("dark");
  });

  test("allows local SVG fragments but rejects remote-resource and redirect vectors", () => {
    expect(normalizeCssEscapes(String.raw`u\72l(\68 ttps://example.com)`)).toBe("url(https://example.com)");
    expect(isSafeMermaidSvgReference("url(#arrowhead)")).toBe(true);
    expect(isSafeMermaidSvgReference("#local-gradient")).toBe(true);
    expect(isSafeMermaidSvgReference("url(https://example.com/tracker.svg)")).toBe(false);
    expect(isSafeMermaidSvgReference("@import url('//example.com/diagram.css')")).toBe(false);
    expect(isSafeMermaidSvgReference("javascript:location='https://example.com'")).toBe(false);
    expect(isSafeMermaidSvgReference("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isSafeMermaidSvgReference(String.raw`background:u\72l(\68 ttps://example.com/tracker.svg)`)).toBe(false);
    expect(isSafeMermaidSvgReference("background:u/**/rl(https://example.com/tracker.svg)")).toBe(false);
  });
});
