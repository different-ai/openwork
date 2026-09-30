import { type Token, type Tokens, Renderer } from "marked";
import { Tokenizer } from "htmlparser2";
import { sessionReferenceHref, type SessionReference } from "@/components/chat/session-reference";
import { SESSION_REFERENCE_LINK_CLASS_NAME } from "@/components/chat/session-reference-link";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

export type ResolveSessionReference = (value: string) => SessionReference | undefined;

// Titles are metadata, never trusted HTML. The output still goes through the
// Markdown primitive's sanitizer; no transcript text or stored token is changed.
function escape(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

export function sessionReferenceHtml(reference: SessionReference) {
  const href = escape(sessionReferenceHref(reference));
  const title = escape(reference.title);
  return `<a href="${href}" data-openwork-session-reference="${href}" aria-label="Open ${reference.archived ? "archived task" : "task"}: ${title}" title="${title}" class="${SESSION_REFERENCE_LINK_CLASS_NAME}"><img src="${escape(resolveExtensionIconSrc("/openwork-sidebar-mark.svg"))}" alt="" aria-hidden="true" class="size-4 shrink-0 object-contain dark:invert"><span class="min-w-0 max-w-64 truncate">${title}</span></a>`;
}

// Raw HTML may contain an anchor, button, or another interactive element that
// Marked doesn't understand. Leave that whole inline run alone rather than risk
// nested interactions. Link/image labels and code blocks are separately excluded.
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
  // A top-level raw HTML opening tag may span multiple Markdown blocks. Within
  // a list/paragraph/table, conservatively leave that whole subtree unenriched.
  const rawHtmlRegion = tokens.some((token) => token.type === "html");
  for (const token of tokens) {
    if (rawHtmlRegion || containsInlineHtml([token])) mark(token);
  }
}

export function stripSessionReferenceAttributes(html: string) {
  // Scan start-tag attributes, preserving text and partial/raw HTML structure.
  // Sanitizing individual HTML tokens would prematurely close opening tags.
  // HTML permits an attribute immediately after a quoted value (even without
  // whitespace), so a whitespace-prefixed replacement is not sufficient.
  let result = "";
  let copied = 0;
  const tokenizer = new Tokenizer({ decodeEntities: false }, {
    onattribname(start, end) {
      if (html.slice(start, end).toLowerCase() !== "data-openwork-session-reference") return;
      // Rename only the actual attribute name. Keeping its value and delimiters
      // intact also preserves malformed-but-browser-accepted HTML faithfully.
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
  // Match complete prose atoms, not substrings of paths, IDs, or URLs. Only the
  // resolver's strict supported forms and known metadata can become references.
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
