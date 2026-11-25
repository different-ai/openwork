import katex from "katex";
import type { MarkedExtension, TokenizerAndRendererExtension, Tokens } from "marked";
import markedKatex from "marked-katex-extension";

const INLINE_PAREN_RULE = /^\\\(([\s\S]+?)\\\)/;
const INLINE_BRACKET_RULE = /^\\\[([\s\S]+?)\\\]/;
const BLOCK_BRACKET_RULE = /^ {0,3}\\\[([\s\S]+?)\\\](?:\n+|$)/;

const KATEX_OPTIONS = {
  throwOnError: false,
  strict: false,
  output: "htmlAndMathml",
} satisfies katex.KatexOptions;

function escapeMathSource(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function mathFallbackHtml(source: string) {
  return `<code data-openwork-math-error="" class="rounded-md bg-gray-2/70 px-1.5 py-0.5 font-mono text-sm text-foreground">${escapeMathSource(source)}</code>`;
}

export function renderMathHtml(text: string, displayMode: boolean) {
  try {
    return katex.renderToString(text, { ...KATEX_OPTIONS, displayMode });
  } catch {
    return mathFallbackHtml(text);
  }
}

function guardRenderer(extension: TokenizerAndRendererExtension): TokenizerAndRendererExtension {
  if (!("renderer" in extension)) {
    return extension;
  }

  const renderer = extension.renderer;

  return {
    ...extension,
    renderer(token) {
      try {
        return renderer.call(this, token);
      } catch {
        return mathFallbackHtml(typeof token.raw === "string" ? token.raw : "");
      }
    },
  };
}

type MathToken = Tokens.Generic & { text: string; displayMode: boolean };

function isMathToken(token: Tokens.Generic): token is MathToken {
  return typeof token.text === "string" && typeof token.displayMode === "boolean";
}

function renderMathToken(token: Tokens.Generic) {
  return isMathToken(token) ? renderMathHtml(token.text, token.displayMode) : false;
}

function bracketMath(
  name: string,
  level: "inline" | "block",
  rule: RegExp,
  displayMode: boolean,
  startDelimiter: string,
): TokenizerAndRendererExtension {
  return {
    name,
    level,
    start(src) {
      const index = src.indexOf(startDelimiter);
      return index === -1 ? undefined : index;
    },
    tokenizer(src) {
      const match = rule.exec(src);

      if (!match) {
        return undefined;
      }

      return { type: name, raw: match[0], text: match[1].trim(), displayMode };
    },
    renderer: renderMathToken,
  };
}

export function markdownMath(): MarkedExtension {
  const dollarExtensions = markedKatex(KATEX_OPTIONS).extensions ?? [];

  return {
    extensions: [
      ...dollarExtensions.map(guardRenderer),
      bracketMath("blockBracketKatex", "block", BLOCK_BRACKET_RULE, true, "\\["),
      bracketMath("inlineBracketKatex", "inline", INLINE_BRACKET_RULE, true, "\\["),
      bracketMath("inlineParenKatex", "inline", INLINE_PAREN_RULE, false, "\\("),
    ],
  };
}
