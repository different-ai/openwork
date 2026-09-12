import { expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AppErrorBoundary,
  buildCrashReport,
  describeCrash,
  redactCrashText,
} from "../src/react-app/shell/app-error-boundary";
import { StartupApp, StartupScreen } from "../src/react-app/shell/startup-screen";
import { ArchitectureMismatchGate } from "../src/react-app/shell/architecture-mismatch-gate";
import { BootStateProvider } from "../src/react-app/shell/boot-state";

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

test("redaction drops query strings and fragments from URLs in the message and stack", () => {
  const error = new Error(
    "Sign-in failed for https://app.openworklabs.com/signin?code=eval-secret-code&state=xyz#accessToken=at",
  );
  error.stack = `Error: ${error.message}\n    at finishSignIn (https://app.openworklabs.com/assets/index-abc.js:1:2345)`;

  const crash = describeCrash(error);
  const report = buildCrashReport(crash, context);

  expect(crash.message).toBe("Sign-in failed for https://app.openworklabs.com/signin");
  expect(crash.stack).toBe(
    "Error: Sign-in failed for https://app.openworklabs.com/signin\n    at finishSignIn (https://app.openworklabs.com/assets/index-abc.js:1:2345)",
  );
  expect(report).not.toContain("eval-secret-code");
  expect(report).not.toContain("accessToken");
  expect(report).toContain("https://app.openworklabs.com/signin");
});

test("redaction drops credentials embedded in a URL authority", () => {
  expect(redactCrashText("fetch failed for https://svc:eval-secret-pass@example.test/path")).toBe(
    "fetch failed for https://example.test/path",
  );
  expect(redactCrashText("fetch failed for https://svc:eval-secret-pass@example.test/path?code=c#f")).toBe(
    "fetch failed for https://example.test/path",
  );
});

test("redaction masks bare token-like pairs outside URLs", () => {
  expect(redactCrashText("Handoff rejected: token=eyJhbGci.payload grant=g-123 state=ok")).toBe(
    "Handoff rejected: token=[redacted] grant=[redacted] state=ok",
  );
  expect(redactCrashText("openworkToken=tok&accessToken=at")).toBe("openworkToken=[redacted]&accessToken=[redacted]");
});

test("redaction keeps file:// stack frames and dev-server line:col positions intact", () => {
  const packaged = "    at render (file:///Applications/OpenWork.app/Contents/Resources/app/dist/assets/index-abc.js:1:2345)";
  expect(redactCrashText(packaged)).toBe(packaged);
  expect(redactCrashText("    at AppRoot (http://localhost:5173/src/react-app/shell/app-root.tsx?t=1725000000:371:23)")).toBe(
    "    at AppRoot (http://localhost:5173/src/react-app/shell/app-root.tsx:371:23)",
  );
});

test("the revealed technical details show the redacted message, never the query value", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const logError = spyOn(console, "error").mockImplementation(() => {});
  function Throws(): ReactNode {
    throw new Error("Deep link rejected: openwork://open?token=eval-secret-token");
  }
  try {
    await act(async () => {
      root.render(<AppErrorBoundary><Throws /></AppErrorBoundary>);
    });
    const toggle = Array.from(container.querySelectorAll("button")).find((button) => /technical details/i.test(button.textContent ?? ""));
    await act(async () => { toggle?.click(); });
    expect(container.textContent).toContain("Deep link rejected: openwork://open");
    expect(container.textContent).not.toContain("eval-secret-token");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    logError.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});

function quotedCrash(sink: string) {
  const fields = ["token", "grant", "code", "secret", "key"];
  const opaque = ["q7Vm2pR8", "b4Nx9wL3", "h6Zd1sK5", "v8Jc3rT2", "m5Yf7aP9"];
  const canaries: string[] = [];
  function assignments(part: string) {
    return fields.map((field, index) => {
      const values = [0, 1, 2, 3].map((variant) => `${sink}${part}${opaque[index]}${variant}`);
      canaries.push(...values);
      return `${field}="${values[0]}" ${field}='${values[1]}' "${field}":"${values[2]}" '${field}':'${values[3]}'`;
    }).join(" ");
  }
  const error = new Error(`Recovery failed: ${assignments("m")} status=502`);
  error.stack = `Error: recovery trace ${assignments("s")}\n    at restoreSession (session-route.tsx:42:7)`;
  return { error, canaries };
}

test("revealed DOM redacts complete quoted assignments in a caught error message and stack", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const logError = spyOn(console, "error").mockImplementation(() => {});
  const { error, canaries } = quotedCrash("d");
  function Throws(): ReactNode {
    throw error;
  }
  try {
    await act(async () => {
      root.render(<AppErrorBoundary><Throws /></AppErrorBoundary>);
    });
    const toggle = Array.from(container.querySelectorAll("button")).find((button) => /technical details/i.test(button.textContent ?? ""));
    if (!toggle) throw new Error("Technical details toggle is missing");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("pre")).toBeNull();
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const stack = container.querySelector("pre");
    const message = stack?.previousElementSibling;
    expect(message?.textContent).toContain("Recovery failed:");
    expect(message?.textContent).toContain("status=502");
    expect(stack?.textContent).toContain("Error: recovery trace");
    expect(stack?.textContent).toContain("at restoreSession (session-route.tsx:42:7)");
    for (const canary of canaries) expect(container.textContent).not.toContain(canary);
    expect(message?.textContent?.match(/\[redacted\]/g)).toHaveLength(20);
    expect(stack?.textContent?.match(/\[redacted\]/g)).toHaveLength(20);
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    logError.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});

test("Copy details writes redacted quoted assignments from a caught error to the clipboard", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const logError = spyOn(console, "error").mockImplementation(() => {});
  const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  const { error, canaries } = quotedCrash("c");
  function Throws(): ReactNode {
    throw error;
  }
  try {
    await act(async () => {
      root.render(<AppErrorBoundary><Throws /></AppErrorBoundary>);
    });
    const toggle = Array.from(container.querySelectorAll("button")).find((button) => /technical details/i.test(button.textContent ?? ""));
    if (!toggle) throw new Error("Technical details toggle is missing");
    await act(async () => { toggle.click(); });
    const copy = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Copy details");
    if (!copy) throw new Error("Copy details button is missing");
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => { copy.click(); });
    expect(writeText).toHaveBeenCalledTimes(1);
    const payload = writeText.mock.calls[0][0];
    const parts = payload.split("\n\n");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toContain("OpenWork ");
    expect(parts[1]).toContain("Recovery failed:");
    expect(parts[1]).toContain("status=502");
    expect(parts[2]).toContain("Error: recovery trace");
    expect(parts[2]).toContain("at restoreSession (session-route.tsx:42:7)");
    for (const canary of canaries) expect(payload).not.toContain(canary);
    expect(parts[1].match(/\[redacted\]/g)).toHaveLength(20);
    expect(parts[2].match(/\[redacted\]/g)).toHaveLength(20);
    expect(copy.textContent).toBe("Copied");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    writeText.mockRestore();
    logError.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});

test("children render untouched when nothing throws", () => {
  const html = renderToStaticMarkup(
    <AppErrorBoundary>
      <p>session surface</p>
    </AppErrorBoundary>,
  );

  expect(html).toBe("<p>session surface</p>");
});

test("the architecture check shows progress without mounting the gated application", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const bridge = window.__OPENWORK_ELECTRON__;
  Reflect.set(window, "__OPENWORK_ELECTRON__", { system: {} });
  try {
    const html = renderToStaticMarkup(
      <BootStateProvider>
        <ArchitectureMismatchGate><p>private workspace</p></ArchitectureMismatchGate>
      </BootStateProvider>,
    );
    expect(html).toContain("Checking this OpenWork installation");
    expect(html).toContain("Reload");
    expect(html).not.toContain("private workspace");
  } finally {
    if (bridge === undefined) Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
    else Reflect.set(window, "__OPENWORK_ELECTRON__", bridge);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});

test.each(["ready", "error"])("pending startup remains actionable and settles to %s without clearing continuity", async (outcome) => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/#/workspace/ws/session/thread" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reload = spyOn(window.location, "reload").mockImplementation(() => {});
  const logError = spyOn(console, "error").mockImplementation(() => {});
  const startup = Promise.withResolvers<ReactNode>();
  const hash = window.location.hash;
  const stored = window.localStorage.getItem("openwork.server.active");
  window.localStorage.setItem("openwork.server.active", "https://self-hosted.example.test/opencode");
  let mounted = 0;
  function Session() {
    mounted += 1;
    return <p>restored thread</p>;
  }
  try {
    await act(async () => {
      root.render(
        <StrictMode>
          <AppErrorBoundary>
            <Suspense fallback={<StartupScreen />}>
              <StartupApp startup={startup.promise} />
            </Suspense>
          </AppErrorBoundary>
        </StrictMode>,
      );
    });
    expect(container.textContent).toContain("Starting OpenWork");
    expect(mounted).toBe(0);
    const retry = container.querySelector("button");
    expect(retry?.textContent).toBe("Reload");
    await act(async () => { retry?.click(); });
    expect(reload).toHaveBeenCalledTimes(1);

    await act(async () => {
      if (outcome === "ready") startup.resolve(<Session />);
      else startup.reject(new Error("bootstrap IPC failed"));
    });
    expect(container.textContent).not.toContain("Starting OpenWork");
    if (outcome === "ready") {
      expect(container.textContent).toBe("restored thread");
      expect(mounted).toBeGreaterThan(0);
    } else {
      expect(container.textContent).toContain("OpenWork hit an unexpected error");
      expect(container.textContent).toContain("Reload");
      expect(container.textContent).not.toContain("bootstrap IPC failed");
      expect(mounted).toBe(0);
    }
    expect(window.location.hash).toBe(hash);
    expect(window.localStorage.getItem("openwork.server.active")).toBe("https://self-hosted.example.test/opencode");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    reload.mockRestore();
    logError.mockRestore();
    if (stored === null) window.localStorage.removeItem("openwork.server.active");
    else window.localStorage.setItem("openwork.server.active", stored);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});
