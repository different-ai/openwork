import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AppErrorBoundary,
  buildCrashReport,
  describeCrash,
} from "../src/react-app/shell/app-error-boundary";

// react-dom/server rethrows instead of running error boundaries, so the catch
// path is exercised by driving the state transition directly:
// getDerivedStateFromError produces the state, then render() produces the
// fallback the user actually sees.
function renderFallback(thrown: unknown): string {
  const boundary = new AppErrorBoundary({ children: null });
  boundary.state = AppErrorBoundary.getDerivedStateFromError(thrown);
  return renderToStaticMarkup(<>{boundary.render()}</>);
}

const context = { version: "0.18.44", deployment: "desktop", flavor: "enterprise" };

test("getDerivedStateFromError captures the message and stack for the fallback", () => {
  const error = new Error("boom");
  expect(AppErrorBoundary.getDerivedStateFromError(error)).toEqual({
    crash: { message: "boom", stack: error.stack ?? "" },
  });
});

test("a captured error renders the recovery screen with the details collapsed", () => {
  const error = new Error("render exploded");
  error.stack = "Error: render exploded\n    at sessionRoute (session-route.tsx:1797)";
  const html = renderFallback(error);

  expect(html).toContain("OpenWork hit an unexpected error");
  expect(html).toContain("Reload");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Technical details");
  // Progressive disclosure: the raw payload and its actions wait behind the toggle.
  expect(html).not.toContain("render exploded");
  expect(html).not.toContain("session-route.tsx:1797");
  expect(html).not.toContain("Copy details");
  expect(html).not.toContain("Open logs folder");
});

test("non-Error throws still produce a readable message", () => {
  expect(describeCrash("Local context is missing")).toEqual({ message: "Local context is missing", stack: "" });
});

test("the copy payload carries message, stack, app version and distribution flavor", () => {
  const error = new Error("Local context is missing");
  error.stack = "Error: Local context is missing\n    at useLocal (providers.tsx:42)";

  const report = buildCrashReport(describeCrash(error), context);

  expect(report.split("\n\n")).toEqual([
    "OpenWork 0.18.44 (desktop, enterprise)",
    "Local context is missing",
    error.stack,
  ]);
});

test("the copy payload omits an empty stack", () => {
  expect(buildCrashReport({ message: "plain", stack: "" }, context)).toBe(
    "OpenWork 0.18.44 (desktop, enterprise)\n\nplain",
  );
});

test("children render untouched when nothing throws", () => {
  const html = renderToStaticMarkup(
    <AppErrorBoundary>
      <p>session surface</p>
    </AppErrorBoundary>,
  );

  expect(html).toBe("<p>session surface</p>");
});
