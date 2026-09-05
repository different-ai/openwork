/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DotMatrixLoader } from "../src/components/ui/dot-matrix-loader";
import { shouldTickWorkspaceElapsedClock } from "../src/react-app/domains/workspace/create-workspace-modal-state";

describe("render cycle state", () => {
  test("only advances the workspace elapsed clock for visible progress", () => {
    expect(shouldTickWorkspaceElapsedClock({
      open: true,
      submitting: true,
      startedAt: 100,
    })).toBe(true);
    expect(shouldTickWorkspaceElapsedClock({
      open: false,
      submitting: true,
      startedAt: 100,
    })).toBe(false);
    expect(shouldTickWorkspaceElapsedClock({
      open: true,
      submitting: true,
      startedAt: null,
    })).toBe(false);
    expect(shouldTickWorkspaceElapsedClock({
      open: true,
      submitting: false,
      startedAt: 100,
    })).toBe(false);
  });

  test("renders the task activity mark as nine CSS-animated dots", () => {
    const html = renderToStaticMarkup(<DotMatrixLoader label="Running" />);

    expect(html.match(/ow-dot-matrix-dot/g)).toHaveLength(9);
    expect(html).toContain("ow-dot-matrix-frame-a");
    expect(html).toContain("ow-dot-matrix-frame-g");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Running"');
  });
});
