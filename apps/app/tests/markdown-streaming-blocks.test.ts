import { describe, expect, spyOn, test } from "bun:test";
import { attachVideoSource, resolveVideoSource, workspaceVideoPath } from "../src/lib/video-source";

import {
  createStreamingMarkdownRenderer,
  renderMarkdownHtml,
  type MarkdownBlockHtml,
} from "../src/components/markdown/markdown-primitive";

// Without a window DOMPurify is inert here, so these assertions compare the
// lexer and parser output that the incremental path actually changes. The
// sanitizer decides per node from allowlists and carries no state between
// sibling blocks, so sanitizing each block on its own yields the same markup.
const joined = (blocks: MarkdownBlockHtml[]) => blocks.map((block) => block.__html).join("");

/** Feed `text` to the renderer a few characters at a time, like a streaming answer. */
function streamThrough(text: string, chunk: number) {
  const renderer = createStreamingMarkdownRenderer();
  const frames: MarkdownBlockHtml[][] = [];
  for (let end = chunk; end < text.length; end += chunk) frames.push(renderer.render(text.slice(0, end)));
  frames.push(renderer.render(text));
  return { renderer, frames };
}

// Shapes where a later line retroactively changes how an earlier line is read:
// setext underlines, lazy list continuation, loose list items after a blank
// line, a table delimiter row, fences and HTML blocks with blank lines inside,
// nested lists, math, and a raw HTML block.
const DOCUMENT = `# Heading

Intro paragraph with **bold**, \`inline.ts\`, and a [link](https://example.com).

Setext title
============

- first item
continues lazily
- second item

  a loose paragraph inside the second item
- third item
  - nested
  - list

| Column | Value |
| --- | --- |
| alpha | 1 |
| beta | 2 |

\`\`\`ts
const a = 1;

const b = 2;
\`\`\`

<div align="center">

inside html

</div>

Display math $$E = mc^2$$ and inline $x$.

> quoted
> lines

Trailing paragraph ***
`;

describe("streaming markdown blocks", () => {
  test("every streamed frame renders the same HTML as the whole-document renderer", () => {
    for (const chunk of [1, 7, 40]) {
      const { frames } = streamThrough(DOCUMENT, chunk);
      let end = chunk;
      for (const blocks of frames) {
        const text = DOCUMENT.slice(0, Math.min(end, DOCUMENT.length));
        expect(joined(blocks)).toBe(renderMarkdownHtml(text));
        end += chunk;
      }
    }
  });

  test("settled blocks keep their payload identity while later blocks stream in", () => {
    const renderer = createStreamingMarkdownRenderer();
    const settled = "# Title\n\nFirst paragraph.\n\n- one\n- two\n\n";
    const before = renderer.render(`${settled}Second par`);
    const after = renderer.render(`${settled}Second paragraph grows.\n\nThird`);

    expect(before.length).toBeGreaterThanOrEqual(4);
    // Everything before the growing tail is the exact same object, so React
    // leaves that DOM alone.
    for (let index = 0; index < before.length - 2; index += 1) {
      expect(after[index]).toBe(before[index]);
    }
    expect(joined(after)).toBe(renderMarkdownHtml(`${settled}Second paragraph grows.\n\nThird`));
    // The same text returns the same array without re-rendering.
    expect(renderer.render(`${settled}Second paragraph grows.\n\nThird`)).toBe(after);
  });

  test("a growing tail can reshape its predecessor block", () => {
    const renderer = createStreamingMarkdownRenderer();
    renderer.render("# Title\n\n- one\n- two\n\nbecomes a heading");
    const blocks = renderer.render("# Title\n\n- one\n- two\n\nbecomes a heading\n===");

    expect(joined(blocks)).toBe(renderMarkdownHtml("# Title\n\n- one\n- two\n\nbecomes a heading\n==="));
    expect(joined(blocks)).toContain("<h1");
  });

  test("reference definitions resolve across blocks on every frame", () => {
    const renderer = createStreamingMarkdownRenderer();
    const withoutDefinition = "# Title\n\nSee [the docs][docs] for more.\n\nAnother paragraph.\n\n";
    expect(joined(renderer.render(withoutDefinition))).toBe(renderMarkdownHtml(withoutDefinition));
    expect(joined(renderer.render(withoutDefinition))).not.toContain("<a ");

    const withDefinition = `${withoutDefinition}[docs]: https://example.com/docs\n`;
    const blocks = renderer.render(withDefinition);
    expect(joined(blocks)).toBe(renderMarkdownHtml(withDefinition));
    expect(joined(blocks)).toContain('href="https://example.com/docs"');

    // Once a definition exists, a later append still re-renders exactly.
    const appended = `${withDefinition}\nAnd [the docs][docs] again.\n`;
    expect(joined(renderer.render(appended))).toBe(renderMarkdownHtml(appended));
  });

  test("replaced text and Windows line endings fall back to a full render that still reuses unchanged blocks", () => {
    const renderer = createStreamingMarkdownRenderer();
    const first = renderer.render("# Title\r\n\r\nParagraph one.\r\n\r\nParagraph two.");
    expect(joined(first)).toBe(renderMarkdownHtml("# Title\n\nParagraph one.\n\nParagraph two."));

    const replaced = renderer.render("# Title\n\nParagraph one.\n\nA different second paragraph.");
    expect(joined(replaced)).toBe(renderMarkdownHtml("# Title\n\nParagraph one.\n\nA different second paragraph."));
    expect(replaced[0]).toBe(first[0]);
    expect(replaced[replaced.length - 1]).not.toBe(first[first.length - 1]);
  });

  test("blank and whitespace-only text renders no visible blocks", () => {
    const renderer = createStreamingMarkdownRenderer();
    expect(renderer.render("")).toEqual([]);
    expect(renderer.render("  \n\n ").every((block) => block.__html === "")).toBe(true);
  });

  test("reset drops the retained frame so the next render starts fresh", () => {
    const renderer = createStreamingMarkdownRenderer();
    const first = renderer.render("# Title\n\nParagraph.");
    renderer.reset();
    const second = renderer.render("# Title\n\nParagraph.");
    expect(joined(second)).toBe(joined(first));
    expect(second).not.toBe(first);
  });
});


test("video references render native players without autoplay or unsafe sources", () => {
  for (const markdown of ["[Video](clip.mp4)", "![Video](clip.webm)", "`clip.mp4`", "[Video](https://example.com/clip.MP4?download=1)"]) {
    const html = renderMarkdownHtml(markdown);
    expect(html).toContain("<video");
    expect(html).toContain("controls playsinline");
    expect(html).not.toContain("autoplay");
    expect(html).not.toContain("data-openwork-image-preview");
    expect(joined(streamThrough(markdown, 3).frames.at(-1)!)).toBe(html);
  }
  expect(renderMarkdownHtml("[Bad](javascript:evil.mp4)")).not.toContain("<video");
  expect(renderMarkdownHtml("[Document](notes.md)")).not.toContain("<video");
});

describe("shared video sources", () => {
  const data = Uint8Array.from([0, 128, 200, 254, 255]).buffer;
  const workspace = { workspaceId: "ws_video", workspaceRoot: "/workspace" };
  const download = { data, contentType: "application/octet-stream", filename: null };

  test("normalizes contained file URLs and relative paths without suffix matching", () => {
    for (const path of ["clip.mp4", "./clip.mp4", "workspace/clip.mp4", "workspaces/ws_video/clip.mp4", "file:///workspace/clip.mp4", "/workspace/clip.mp4"]) {
      expect(workspaceVideoPath(path, "/workspace")).toBe("clip.mp4");
    }
    expect(workspaceVideoPath("file:///workspace/a%20b.mp4", "/workspace")).toBe("a b.mp4");
    expect(workspaceVideoPath("file:///C:/Work/clip.mp4", "c:\\Work")).toBe("clip.mp4");
    expect(workspaceVideoPath("file://server/share/clip.mp4", "\\\\server\\share")).toBe("clip.mp4");
    for (const path of ["/outside/clip.mp4", "/workspace-other/clip.mp4", "../clip.mp4", "%2e%2e/clip.mp4", "file:///workspace/../outside/clip.mp4", "file://outside/workspace/clip.mp4", "//outside/clip.mp4", "javascript:clip.mp4", "java\nscript:clip.mp4", "https://example.com/clip.mp4"]) {
      expect(workspaceVideoPath(path, "/workspace")).toBeNull();
    }
    expect(workspaceVideoPath("/workspace/clip.mp4")).toBeNull();
  });

  test("downloads through the authenticated client with intact bytes and MIME fallback", async () => {
    const requests: string[][] = [];
    const client = {
      baseUrl: "https://worker.example.test/api",
      downloadWorkspaceFile: async (id: string, path: string) => { requests.push([id, path]); return download; },
    };
    for (const href of ["file:///workspace/clip.MOV", "./clip.MOV", `${client.baseUrl}/workspace/ws_video/files/raw?path=clip.MOV`]) {
      const result = await resolveVideoSource({ href, client, ...workspace });
      expect(result).toBeInstanceOf(Blob);
      if (!(result instanceof Blob)) throw new Error("Expected video bytes");
      expect(result.type).toBe("video/quicktime");
      expect(await result.arrayBuffer()).toEqual(data);
    }
    expect(requests).toEqual(Array.from({ length: 3 }, () => ["ws_video", "clip.MOV"]));
    await expect(resolveVideoSource({ href: "file:///outside/clip.MOV", client, ...workspace })).rejects.toThrow();
    expect(requests).toHaveLength(3);
  });

  test("allows public, data and blob videos without sending workspace credentials", async () => {
    const client = { baseUrl: "https://worker.example.test", downloadWorkspaceFile: async () => { throw new Error("Must not download"); } };
    for (const href of ["https://example.com/clip.mp4?signature=test", "data:video/mp4;base64,AA==", "blob:https://example.com/clip", "blob:null/clip"]) {
      expect(await resolveVideoSource({ href, client, ...workspace })).toBe(href);
    }
    for (const href of ["javascript:clip.mp4", "data:text/html,<script></script>", "blob:javascript:clip", "ftp://example.com/clip.mp4", "https://user:secret@example.com/clip.mp4"]) {
      await expect(resolveVideoSource({ href, client, ...workspace })).rejects.toThrow();
    }
  });

  test("shows loading and errors, releases URLs, and ignores late resolution after cleanup", async () => {
    const { GlobalRegistrator } = await import("@happy-dom/global-registrator");
    GlobalRegistrator.register({ url: "https://app.example.test" });
    const created = spyOn(URL, "createObjectURL").mockReturnValue("blob:https://app.example.test/video");
    const revoked = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let cleanup: (() => void) | undefined;
    try {
      const video = document.createElement("video");
      const notice = document.createElement("span");
      const pending = Promise.withResolvers<typeof download>();
      const client = { baseUrl: "https://worker.example.test", downloadWorkspaceFile: () => pending.promise };
      cleanup = attachVideoSource(video, notice, { href: "clip.mp4", client, ...workspace });
      expect(notice.textContent).toBe("Loading video...");
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      cleanup();
      pending.resolve(download);
      await pending.promise;
      await Promise.resolve();
      expect(created).not.toHaveBeenCalled();
      expect(video.hasAttribute("src")).toBe(false);

      cleanup = attachVideoSource(video, notice, { href: "clip.mp4", client, ...workspace });
      await Promise.resolve();
      await Promise.resolve();
      expect(created).toHaveBeenCalledTimes(1);
      video.dispatchEvent(new Event("loadedmetadata"));
      expect(notice.hidden).toBe(true);
      video.dispatchEvent(new Event("error"));
      expect(notice.hidden).toBe(false);
      expect(notice.textContent).toContain("Video preview unavailable");
      cleanup();
      expect(revoked).toHaveBeenCalledWith("blob:https://app.example.test/video");
      expect(video.hasAttribute("src")).toBe(false);

      cleanup = attachVideoSource(video, notice, { href: "../clip.mp4", client, ...workspace });
      await Promise.resolve();
      await Promise.resolve();
      expect(notice.textContent).toContain("Video preview unavailable");
      expect(created).toHaveBeenCalledTimes(1);
    } finally {
      cleanup?.();
      created.mockRestore();
      revoked.mockRestore();
      await GlobalRegistrator.unregister();
    }
  });
});
