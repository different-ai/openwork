/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HTMLPreview } from "../src/react-app/domains/session/artifacts/preview";

function sandboxOf(markup: string) {
  const match = /sandbox="([^"]*)"/.exec(markup);
  if (!match) throw new Error(`No sandbox attribute in ${markup}`);
  return match[1].split(/\s+/).filter(Boolean);
}

describe("HTMLPreview", () => {
  test("inline HTML runs scripts in an opaque origin", () => {
    const markup = renderToStaticMarkup(<HTMLPreview type="text" title="page.html" content="<script>1</script>" />);
    expect(markup).toContain("srcDoc=");
    expect(sandboxOf(markup)).toEqual(["allow-scripts"]);
  });

  test("blob HTML runs scripts in an opaque origin", () => {
    const markup = renderToStaticMarkup(<HTMLPreview type="binary" title="page.html" url="blob:http://localhost/preview" />);
    expect(markup).toContain('src="blob:http://localhost/preview"');
    expect(sandboxOf(markup)).toEqual(["allow-scripts"]);
  });
});
