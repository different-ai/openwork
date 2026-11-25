import { type Token, type Tokens, Renderer } from "marked";
import { Tokenizer } from "htmlparser2";
import { sessionReferenceHref, type SessionReference } from "@/components/chat/session-reference";
import { SESSION_REFERENCE_ICON_CLASS_NAME, SESSION_REFERENCE_LINK_CLASS_NAME } from "@/components/chat/session-reference-link";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

export type ResolveSessionReference = (value: string) => SessionReference | undefined;

function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

export function sessionReferenceHtml(reference: SessionReference) {
  const href = escape(sessionReferenceHref(reference));
  const title = escape(reference.title);
  return `<a href="${href}" data-openwork-session-reference="${href}" aria-label="Open ${reference.archived ? "archived task" : "task"}: ${title}" title="${title}" class="${SESSION_REFERENCE_LINK_CLASS_NAME}"><img src="${escape(resolveExtensionIconSrc("/openwork-sidebar-mark.svg"))}" alt="" aria-hidden="true" class="${SESSION_REFERENCE_ICON_CLASS_NAME}"><span class="min-w-0 max-w-64 truncate">${title}</span></a>`;
}

function children(token: Token): Token[] {
  if (token.type === "list" && "items" in token) return token.items;
  if (token.type === "table" && "header" in token && "rows" in token) return [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens);
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : [];
}

export function containsInlineHtml(tokens: Token[]): boolean {
  return tokens.some((token) => token.type === "html" || containsInlineHtml(children(token)));
}

export function markUnsafeReferenceTokens(tokens: Token[], unsafe: WeakSet<object>) {
  const mark = (token: Token) => {
    unsafe.add(token);
    for (const child of children(token)) mark(child);
  };
  const rawHtmlRegion = tokens.some((token) => token.type === "html");
  for (const token of tokens) {
    if (rawHtmlRegion || containsInlineHtml([token])) mark(token);
  }
}

export function stripSessionReferenceAttributes(html: string) {
  let result = "";
  let copied = 0;
  const tokenizer = new Tokenizer({ decodeEntities: false }, {
    onattribname(start, end) {
      if (html.slice(start, end).toLowerCase() !== "data-openwork-session-reference") return;
      result += html.slice(copied, start) + "data-openwork-untrusted-reference";
      copied = end;
    },
    onattribdata() {}, onattribentity() {}, onattribend() {},
    oncdata() {}, onclosetag() {}, oncomment() {}, ondeclaration() {},
    onend() {}, onopentagend() {}, onopentagname() {},
    onprocessinginstruction() {}, onselfclosingtag() {}, ontext() {}, ontextentity() {},
  });
  tokenizer.write(html);
  tokenizer.end();
  return result + html.slice(copied);
}

const defaultRenderer = new Renderer();

export function renderSessionReferenceText(token: Tokens.Text | Tokens.Escape, resolve: ResolveSessionReference): string | false {
  if (token.type !== "text" || token.tokens) return false;
  let cursor = 0;
  let result = "";
  for (const match of token.text.matchAll(/[^\s()[\]{}<>"'`]+/g)) {
    const raw = match[0].replace(/[.,;:!]+$/, "");
    const reference = resolve(raw);
    if (!reference) continue;
    result += defaultRenderer.text({ ...token, text: token.text.slice(cursor, match.index) });
    result += sessionReferenceHtml(reference);
    cursor = match.index + raw.length;
  }
  return cursor ? result + defaultRenderer.text({ ...token, text: token.text.slice(cursor) }) : false;
}
