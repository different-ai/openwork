"use client";

import { Fragment, type ReactNode } from "react";

/**
 * Reads a skill's Markdown body as a document: headings, paragraphs, lists,
 * quotes and code. Builds React elements only (no HTML injection), so any
 * unsupported syntax simply shows as text.
 */

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" };

const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+(.*)$/;

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trimStart().startsWith("```")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: (heading[2] ?? "").replace(/\s+#+\s*$/, "") });
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? "").trimStart().startsWith(">")) {
        quote.push((lines[index] ?? "").trimStart().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", text: quote.join(" ") });
      continue;
    }
    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[1] ?? "");
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const item = LIST_ITEM.exec(current);
        if (item) {
          items.push(item[2] ?? "");
        } else if (current.trim() !== "" && /^\s{2,}/.test(current) && items.length > 0) {
          items[items.length - 1] = `${items[items.length - 1]} ${current.trim()}`;
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (current.trim() === "" || /^(#{1,6})\s/.test(current) || LIST_ITEM.test(current) || current.trimStart().startsWith("```") || current.trimStart().startsWith(">")) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

/** `code`, **bold** and *italic*; everything else stays literal text. */
function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*)/g);
  return parts.map((part, index) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return <code key={index} className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[12.5px] text-gray-800">{part.slice(1, -1)}</code>;
    }
    if ((part.startsWith("**") && part.endsWith("**")) || (part.startsWith("__") && part.endsWith("__"))) {
      return <strong key={index} className="font-semibold text-gray-900">{part.slice(2, -2)}</strong>;
    }
    if (part.length > 2 && part.startsWith("*") && part.endsWith("*")) {
      return <em key={index}>{part.slice(1, -1)}</em>;
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function SkillInstructions({ markdown, title }: { markdown: string; title: string }) {
  const blocks = parseBlocks(markdown);
  // The page already shows the title; a leading "# Same title" would repeat it.
  const first = blocks[0];
  if (first?.kind === "heading" && normalize(first.text) === normalize(title)) blocks.shift();

  if (blocks.length === 0) {
    return <p className="text-[14px] text-gray-500">No instructions yet.</p>;
  }

  return (
    <div className="flex max-w-[68ch] flex-col gap-3.5 text-[14px] leading-[1.7] text-gray-700" data-testid="skill-instructions">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return block.level <= 2
              ? <h3 key={index} className="pt-3 text-[15px] font-semibold leading-6 tracking-[-0.1px] text-gray-950 first:pt-0">{inline(block.text)}</h3>
              : <h4 key={index} className="pt-2 text-[14px] font-semibold leading-6 text-gray-900 first:pt-0">{inline(block.text)}</h4>;
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "list":
            return block.ordered ? (
              <ol key={index} className="flex list-decimal flex-col gap-1.5 pl-5 marker:text-[var(--dls-text-secondary)]">
                {block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1">{inline(item)}</li>)}
              </ol>
            ) : (
              <ul key={index} className="flex list-disc flex-col gap-1.5 pl-5 marker:text-[var(--dls-text-secondary)]">
                {block.items.map((item, itemIndex) => <li key={itemIndex} className="pl-1">{inline(item)}</li>)}
              </ul>
            );
          case "quote":
            return <blockquote key={index} className="border-l-2 border-gray-200 pl-4 text-gray-600">{inline(block.text)}</blockquote>;
          case "code":
            return <pre key={index} className="overflow-x-auto rounded-xl bg-gray-50 px-4 py-3 font-mono text-[12.5px] leading-6 text-gray-800">{block.text}</pre>;
          case "rule":
            return <hr key={index} className="border-gray-100" />;
        }
      })}
    </div>
  );
}
