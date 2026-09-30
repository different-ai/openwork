import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LpParityTable } from "../components/lp-parity-table";

describe("Comparison accessibility", () => {
  test("exposes status text once per cell rather than naming bare spans", () => {
    const html = renderToStaticMarkup(createElement(LpParityTable));
    expect(html).not.toMatch(/<span[^>]*aria-label=/);
    expect(html).not.toContain('aria-label="Included"');
    expect(html).not.toContain('aria-label="Not available"');
    // Both responsive layouts contain 10 OpenWork checks and 6 Cowork checks.
    expect(html.match(/<span class="sr-only">Included<\/span>/g)).toHaveLength(32);
    expect(html.match(/<span class="sr-only">Not available<\/span>/g)).toHaveLength(10);
  });

  test("uses a darker blue for the small comparison badge", () => {
    const html = renderToStaticMarkup(createElement(LpParityTable));
    expect(html).toContain('text-[#1d4ed8]');
    expect(html).toContain('bg-[#dbeafe]');
  });
});
