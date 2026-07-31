import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AppErrorBoundary } from "../src/react-app/shell/app-error-boundary";

// react-dom/server rethrows instead of running error boundaries, so the catch
// path is exercised by driving the state transition directly:
// getDerivedStateFromError produces the state, then render() produces the
// fallback the user actually sees.
function renderFallback(error: Error): string {
  const boundary = new AppErrorBoundary({ children: null });
  boundary.state = AppErrorBoundary.getDerivedStateFromError(error);
  return renderToStaticMarkup(<>{boundary.render()}</>);
}

test("getDerivedStateFromError captures the error for the fallback", () => {
  const error = new Error("boom");
  expect(AppErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });
});

test("a captured error renders the recovery screen instead of a blank window", () => {
  const html = renderFallback(new Error("render exploded"));

  expect(html).toContain("OpenWork hit an unexpected error");
  expect(html).toContain("render exploded");
  expect(html).toContain("Reload");
  expect(html).toContain("Copy details");
});

test("the recovery screen prefers a stack when one is available", () => {
  const error = new Error("no stack here");
  error.stack = "Error: no stack here\n    at sessionRoute (session-route.tsx:1797)";

  expect(renderFallback(error)).toContain("session-route.tsx:1797");
});

test("children render untouched when nothing throws", () => {
  const html = renderToStaticMarkup(
    <AppErrorBoundary>
      <p>session surface</p>
    </AppErrorBoundary>,
  );

  expect(html).toBe("<p>session surface</p>");
});
