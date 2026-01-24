import assert from "node:assert/strict";
import { marked } from "marked";

function createCustomRenderer(tone = "light") {
  const renderer = new marked.Renderer();
  const codeBlockClass =
    tone === "dark"
      ? "bg-gray-12/10 border-gray-11/20 text-gray-12"
      : "bg-gray-1/80 border-gray-6/70 text-gray-12";
  const inlineCodeClass =
    tone === "dark"
      ? "bg-gray-12/15 text-gray-12"
      : "bg-gray-2/70 text-gray-12";

  const escapeHtml = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const isSafeUrl = (url) => {
    const protocol = (url || "").trim().toLowerCase();
    return !protocol.startsWith("javascript:") && !protocol.startsWith("data:");
  };

  renderer.html = ({ text }) => escapeHtml(text);

  renderer.code = ({ text, lang }) => {
    const language = lang || "";
    return `
      <div class="rounded-2xl border px-4 py-3 my-4 ${codeBlockClass}">
        ${
          language
            ? `<div class="text-[10px] uppercase tracking-[0.2em] text-gray-9 mb-2">${escapeHtml(
                language,
              )}</div>`
            : ""
        }
        <pre class="overflow-x-auto whitespace-pre text-[13px] leading-relaxed font-mono"><code>${escapeHtml(
          text,
        )}</code></pre>
      </div>
    `;
  };

  renderer.codespan = ({ text }) =>
    `<code class="rounded-md px-1.5 py-0.5 text-[13px] font-mono ${inlineCodeClass}">${escapeHtml(
      text,
    )}</code>`;

  renderer.link = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "#") : "#";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <a
        href="${safeHref}"
        target="_blank"
        rel="noopener noreferrer"
        class="underline underline-offset-2 text-blue-600 hover:text-blue-700"
        ${safeTitle ? `title="${safeTitle}"` : ""}
      >
        ${text}
      </a>
    `;
  };

  renderer.image = ({ href, title, text }) => {
    const safeHref = isSafeUrl(href) ? escapeHtml(href ?? "") : "";
    const safeTitle = title ? escapeHtml(title) : "";
    return `
      <img
        src="${safeHref}"
        alt="${escapeHtml(text || "")}"
        ${safeTitle ? `title="${safeTitle}"` : ""}
        class="max-w-full h-auto rounded-lg my-4"
      />
    `;
  };

  return renderer;
}

function render(text) {
  const renderer = createCustomRenderer("light");
  const result = marked.parse(text, {
    breaks: true,
    gfm: true,
    renderer,
    async: false,
  });
  return typeof result === "string" ? result : "";
}

const cases = [
  {
    name: "script tags are escaped",
    input: "<script>alert(1)</script>",
    assert(output) {
      assert.ok(
        !output.includes("<script>"),
        "script tag should not appear in output",
      );
      assert.ok(
        output.includes("&lt;script&gt;"),
        "script tag should be escaped",
      );
    },
  },
  {
    name: "javascript: links are blocked",
    input: "[click me](javascript:alert(1))",
    assert(output) {
      assert.ok(
        !output.toLowerCase().includes("javascript:"),
        "javascript: URLs must be stripped",
      );
      assert.ok(
        output.includes('href="#\"') || output.includes('href="#"'),
        "unsafe hrefs should fall back to #",
      );
    },
  },
  {
    name: "data: links are blocked",
    input: "[img](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    assert(output) {
      assert.ok(
        !output.toLowerCase().includes("data:"),
        "data: URLs must be stripped",
      );
    },
  },
  {
    name: "http links are preserved",
    input: "[ok](https://example.com)",
    assert(output) {
      assert.ok(
        output.includes('href="https://example.com"'),
        "https:// link should be preserved",
      );
    },
  },
  {
    name: "image alt text and title are escaped",
    input: '![alt<script>](https://example.com/x.png "title<script>")',
    assert(output) {
      assert.ok(!output.includes("<script>"), "raw script must not appear");
      assert.ok(
        output.includes('alt="alt&lt;script&gt;"'),
        "alt text should be escaped",
      );
      assert.ok(
        output.includes('title="title&lt;script&gt;"'),
        "title should be escaped",
      );
    },
  },
];

let passed = 0;
for (const test of cases) {
  const out = render(test.input);
  try {
    test.assert(out);
    passed += 1;
  } catch (err) {
    console.error(
      JSON.stringify({
        ok: false,
        test: test.name,
        error: err instanceof Error ? err.message : String(err),
        output: out,
      }),
    );
    process.exitCode = 1;
  }
}

if (passed === cases.length && process.exitCode !== 1) {
  console.log(JSON.stringify({ ok: true, passed }));
}