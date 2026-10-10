"use client";

import { Fragment, type ReactNode } from "react";
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
        <a href={href} target="_blank" rel="noreferrer noopener" className="underline decoration-[var(--wb-disabled)] underline-offset-2 hover:decoration-current">
          {inline(token.tokens)}
        </a>
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

export function WorkbotMarkdown({ text }: { text: string }) {
  const tokens = Lexer.lex(text, { gfm: true, breaks: true });
  return <div className="flex flex-col gap-3 break-words text-[15px] leading-6 text-[var(--wb-text)]">{tokens.map(block)}</div>;
}
