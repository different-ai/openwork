/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EndedSandboxNotice } from "@openwork/ui/sandbox-trial-notice";

test("ended trials explain recovery in a non-interactive status notice", () => {
  for (const state of ["closed", "expired"] as const) {
    const html = renderToStaticMarkup(<EndedSandboxNotice state={state} className="notice" />);
    expect(html).toContain('role="status"');
    expect(html).toContain("This sandbox trial has ended.");
    expect(html).toContain("Ask a platform admin to reopen it");
  }
});

test("an open trial or an unknown status renders nothing", () => {
  for (const state of ["open", null, undefined] as const) {
    expect(renderToStaticMarkup(<EndedSandboxNotice state={state} className="notice" />)).toBe("");
  }
});
