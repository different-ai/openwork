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
      return <code className="rounded-md bg-[var(--dls-hover)] px-1.5 py-0.5 font-mono text-[12px]">{token.text}</code>;
    case "br":
      return <br />;
    case "link": {
      const href = safeHref(token.href);
      return href ? (
        <a href={href} target="_blank" rel="noreferrer noopener" className="underline decoration-[var(--dls-border)] underline-offset-2 hover:decoration-current">
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
      return <hr key={index} className="border-[var(--dls-border)]" />;
    case "blockquote":
      return (
        <blockquote key={index} className="border-l-2 border-[var(--dls-border)] pl-3 text-[var(--dls-text-secondary)]">
          {token.tokens.map(block)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={index} className="overflow-x-auto rounded-xl bg-[var(--dls-hover)] px-3 py-2 font-mono text-[12px] leading-5">
          <code>{token.text}</code>
        </pre>
      );
    case "list": {
      const items = token.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          {item.tokens.map((child, childIndex) => (child.type === "text" ? <Fragment key={childIndex}>{inlineToken(child)}</Fragment> : block(child, childIndex)))}
        </li>
      ));
      return token.ordered
        ? <ol key={index} className="list-decimal space-y-1 pl-5">{items}</ol>
        : <ul key={index} className="list-disc space-y-1 pl-5">{items}</ul>;
    }
    case "table":
      return (
        <div key={index} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[13px]">
            <thead>
              <tr>{token.header.map((cell, cellIndex) => <th key={cellIndex} className="border-b border-[var(--dls-border)] py-1.5 pr-4 font-semibold">{inline(cell.tokens)}</th>)}</tr>
            </thead>
            <tbody>
              {token.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} className="border-b border-[var(--dls-border)] py-1.5 pr-4 align-top">{inline(cell.tokens)}</td>)}</tr>
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
  return <div className="space-y-2 break-words text-[14px] leading-[1.6]">{tokens.map(block)}</div>;
}
