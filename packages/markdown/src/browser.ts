import DOMPurify from "dompurify";
import {
  transformerMetaHighlight,
  transformerMetaWordHighlight,
  transformerNotationDiff,
  transformerNotationErrorLevel,
  transformerNotationFocus,
  transformerNotationHighlight,
  transformerNotationWordHighlight,
} from "@shikijs/transformers";
import { bundledLanguages, codeToHtml } from "shiki";

import { createMarkdownRenderingKernel } from "./index";

function sanitizeMarkdownHtml(value: string) {
  return DOMPurify.sanitize(value, {
    ADD_ATTR: [
      "checked",
      "class",
      "data-openwork-image-preview",
      "data-openwork-image-toggle",
      "data-openwork-image-toggle-label",
      "data-openwork-link-href",
      "data-openwork-link-chevron",
      "data-openwork-shiki",
      "decoding",
      "disabled",
      "hidden",
      "loading",
      "rel",
      "start",
      "style",
      "target",
    ],
  });
}

export const browserMarkdownRenderingKernel = createMarkdownRenderingKernel({
  sanitizeHtml: sanitizeMarkdownHtml,
  isHighlightLanguageSupported: (language) => language in bundledLanguages,
  highlightCode: ({ code, language, meta }) => codeToHtml(code, {
    lang: language,
    meta: { __raw: meta.join(" ") },
    theme: "github-light",
    transformers: [
      transformerNotationDiff({ matchAlgorithm: "v3" }),
      transformerNotationHighlight({ matchAlgorithm: "v3" }),
      transformerNotationWordHighlight({ matchAlgorithm: "v3" }),
      transformerNotationFocus({ matchAlgorithm: "v3" }),
      transformerNotationErrorLevel({ matchAlgorithm: "v3" }),
      transformerMetaHighlight(),
      transformerMetaWordHighlight(),
    ],
  }),
});
