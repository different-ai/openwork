"use client";

import { Fragment, memo, type ReactNode } from "react";
import { googleDriveFileId } from "@openwork/types/workbot-context";
import { WorkspaceLink } from "./workspace";
import { Lexer, type MarkedToken, type Token } from "marked";

/**
 * Renders an answer's Markdown as React elements. Model output can carry text
 * from anywhere (a page, an email, a message), so nothing is ever injected as
 * HTML: raw HTML is shown as text, and links open only http(s) and mailto.
 */

const KNOWN = new Set<string>([
  "blockquote", "br", "checkbox", "code", "codespan", "def", "del", "em", "escape", "heading", "hr", "html",
  "image", "link", "list", "list_item", "paragraph", "space", "strong", "table", "text",
]);

function isMarked(token: Token): token is MarkedToken {
  return KNOWN.has(token.type);
}

function safeHref(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function inline(tokens: Token[] | undefined): ReactNode {
  return tokens?.map((token, index) => <Fragment key={index}>{inlineToken(token)}</Fragment>);
}

function inlineToken(token: Token): ReactNode {
  if (!isMarked(token)) return "raw" in token && typeof token.raw === "string" ? token.raw : null;
  switch (token.type) {
    case "strong":
      return <strong className="font-semibold">{inline(token.tokens)}</strong>;
    case "em":
      return <em>{inline(token.tokens)}</em>;
    case "del":
      return <del>{inline(token.tokens)}</del>;
    case "codespan":
      return <code className="rounded-md bg-[var(--wb-chip)] px-1.5 py-0.5 font-mono text-[12px]">{token.text}</code>;
    case "br":
      return <br />;
    case "link": {
      const href = safeHref(token.href);
      return href ? (
        <WorkspaceLink href={href}>
          {inline(token.tokens)}
        </WorkspaceLink>
      ) : inline(token.tokens);
    }
    case "image":
      return token.text;
    case "text":
      return token.tokens ? inline(token.tokens) : token.text;
    case "escape":
    case "html":
      return token.text;
    default:
      return token.raw;
  }
}

function block(token: Token, index: number): ReactNode {
  if (!isMarked(token)) return null;
  switch (token.type) {
    case "space":
    case "def":
      return null;
    case "paragraph":
      return <p key={index}>{inline(token.tokens)}</p>;
    case "heading":
      return <p key={index} className="font-semibold">{inline(token.tokens)}</p>;
    case "hr":
      return <hr key={index} className="border-[var(--wb-disabled)]" />;
    case "blockquote":
      // A quoted draft: a quiet bar, the words in full ink (Paper v4, screen 3).
      return (
        <blockquote key={index} className="flex gap-3">
          <span aria-hidden className="w-0.5 shrink-0 rounded-[1px] bg-[var(--wb-disabled)]" />
          <span className="flex min-w-0 flex-col gap-1.5">{token.tokens.map(block)}</span>
        </blockquote>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto rounded-xl bg-[var(--wb-chip)] px-3 py-2 font-mono text-[12px] leading-5">
          <code>{token.text}</code>
        </pre>
      );
    case "list": {
      const items = token.items.map((item, itemIndex) => {
        const content = item.tokens.flatMap((child, childIndex): ReactNode[] =>
          child.type === "checkbox"
            ? []
            : child.type === "text"
              ? [<span key={childIndex}>{inlineToken(child)}</span>]
              : item.task && child.type === "paragraph" && isMarked(child) && "tokens" in child
                ? [<span key={childIndex}>{inline(child.tokens)}</span>]
                : [block(child, childIndex)],
        );
        if (!item.task) {
          return (
            <li key={itemIndex} className="flex gap-2">
              <span aria-hidden className={`shrink-0 text-[var(--wb-muted)] ${token.ordered ? "min-w-4 tabular-nums" : "w-2.5"}`}>
                {token.ordered ? `${(typeof token.start === "number" ? token.start : 1) + itemIndex}.` : "•"}
              </span>
              <span className="flex min-w-0 flex-col gap-1.5">{content}</span>
            </li>
          );
        }
        return (
          <li key={itemIndex} className="flex items-start gap-2">
            <span
              aria-label={item.checked ? "Done" : "Not done"}
              className={`mt-[0.3em] h-3.5 w-3.5 shrink-0 rounded-[4px] border ${item.checked ? "border-[var(--wb-ink)] bg-[var(--wb-ink)]" : "border-[var(--wb-muted)]"}`}
            />
            <span className="min-w-0">{content}</span>
          </li>
        );
      });
      // Task lists show their checkbox instead of a bullet or number.
      return token.ordered
        ? <ol key={index} className="flex flex-col gap-1">{items}</ol>
        : <ul key={index} className="flex flex-col gap-1">{items}</ul>;
    }
    case "table":
      return (
        <div key={index} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr>{token.header.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-[var(--wb-disabled)] py-1.5 pr-4 font-semibold">{inline(cell.tokens)}</th>)}</tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-[var(--wb-disabled)] py-1.5 pr-4 align-top">{inline(cell.tokens)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "html":
      return <p key={index}>{token.text}</p>;
    default:
      return <p key={index}>{inlineToken(token)}</p>;
  }
}

/**
 * An answer's text as its top-level blocks. Always the whole text as one document: a list's numbering, a link's
 * definition or a table can depend on lines far apart.
 */
export function markdownBlocks(text: string): Token[] {
  return Lexer.lex(text, { gfm: true, breaks: true });
}

/** Google Drive files a reply links to, in order and once each, labelled with the reply's own link text. */
export function documentLinks(text: string): Array<{ fileId: string; label: string }> {
  const found = new Map<string, string>();
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object" || value === null) return;
    const token = value as { type?: unknown; href?: unknown; text?: unknown; tokens?: unknown; items?: unknown };
    if (token.type === "link" && typeof token.href === "string") {
      const href = safeHref(token.href);
      const fileId = href ? googleDriveFileId(href) : null;
      const label = typeof token.text === "string" ? token.text.trim() : "";
      if (fileId && label && !found.has(fileId)) found.set(fileId, label);
      return;
    }
    visit(token.tokens);
    visit(token.items);
  };
  visit(markdownBlocks(text));
  return [...found].map(([fileId, label]) => ({ fileId, label }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Whether two parsed tokens read the same all the way down. Tokens are plain data: text, numbers, lists and records. */
export function sameToken(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isRecord(a) || !isRecord(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameToken(a[key], b[key]));
}

/**
 * One top-level block of an answer (a paragraph, a list, a table…), in its place. What it shows comes from its token
 * alone, so it re-renders only when that token reads differently: a reply being written re-renders the block it is
 * writing, not every block above it.
 */
const MarkdownBlock = memo(function MarkdownBlock({ token }: { token: Token }) {
  return block(token, 0);
}, (previous, next) => sameToken(previous.token, next.token));

/**
 * Re-rendered only when its text changes: each streamed word re-reads the bubble it lands in, not every answer above.
 * Within the bubble the text is read again in full, and only the blocks that came out differently re-render.
 */
export const WorkbotMarkdown = memo(function WorkbotMarkdown({ text }: { text: string }) {
  return <div className="flex flex-col gap-3 break-words text-[15px] leading-6 text-[var(--wb-text)]">{markdownBlocks(text).map((token, index) => <MarkdownBlock key={index} token={token} />)}</div>;
});
