import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

await import("../src/components/markdown/markdown-primitive");
GlobalRegistrator.register({ url: "http://localhost/index.html" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
const { MarkdownBlock } = await import("../src/components/markdown/markdown");
const { OpenTargetProvider } = await import("../src/lib/target-provider");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { toast } = await import("sonner");
import type { OpenTargetOptions } from "../src/lib/target-provider";
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
afterAll(() => GlobalRegistrator.unregister());

async function render(isLocalWorkspace = true, workspaceRoot = "/workspace", href = "file:///tmp/Report%20Final.pdf") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const opened: { target: OpenTarget; options?: OpenTargetOptions }[] = [];
  const platform = createDefaultPlatform();
  await act(async () => {
    root?.render(createElement(PlatformProvider, {
      value: { ...platform, platform: "desktop", os: "macos", capabilities: { ...platform.capabilities, revealInFileManager: true } },
      children: createElement(OpenTargetProvider, {
        workspaceRoot,
        isLocalWorkspace,
        openTargets: [],
        onOpenTarget: (target, options) => { opened.push({ target, options }); },
        children: createElement(MarkdownBlock, { text: `[Report](<${href}>) and [Website](https://example.com/docs?q=one#section)` }),
      }),
    }));
  });
  const element = (selector: string) => {
    const found = host.querySelector(selector);
    if (!(found instanceof HTMLElement)) throw new Error(`Missing ${selector}: ${host.innerHTML}`);
    return found;
  };
  const button = (text: string) => {
    const found = [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text);
    if (!found) throw new Error(`Missing button ${text}: ${host.innerHTML}`);
    return found;
  };
  return { host, opened, element, button };
}

async function context(target: HTMLElement) {
  const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}

test("file URL chevrons open an inventory-independent menu, copy the decoded path and dispatch reveal", async () => {
  const view = await render();
  const chevron = view.element("[data-openwork-link-chevron]");
  expect(view.element("a").getAttribute("href")).toBe("#");
  chevron.focus();
  await act(async () => chevron.click());
  expect(document.activeElement).toBe(view.button("Copy path"));
  expect(view.host.textContent).not.toContain("Open with default app");
  await act(async () => view.button("Copy path").click());
  expect(await navigator.clipboard.readText()).toBe("/tmp/Report Final.pdf");
  expect(document.activeElement).toBe(chevron);
  expect((await context(view.element("a"))).defaultPrevented).toBe(true);
  await act(async () => view.button("Reveal in Finder").click());
  expect(view.opened).toEqual([{ target: expect.objectContaining({ value: "file:///tmp/Report%20Final.pdf" }), options: { external: true, reveal: true } }]);
});

test("relative paths use the owning workspace and web context menus remain native", async () => {
  const view = await render(true, "/secondary", "./reports/Report.pdf");
  expect((await context(view.element("a"))).defaultPrevented).toBe(true);
  expect(view.host.textContent).toContain("Open with default app");
  await act(async () => view.button("Copy path").click());
  expect(await navigator.clipboard.readText()).toBe("/secondary/reports/Report.pdf");
  const web = view.element('a[data-openwork-link-href^="https:"]');
  expect((await context(web)).defaultPrevented).toBe(false);
  expect(web.getAttribute("href")).toBe("https://example.com/docs?q=one#section");
  await act(async () => web.click());
  expect(view.opened[0]?.target.value).toBe("https://example.com/docs?q=one#section");
});

test("remote paths offer copy and preview but never local application or reveal actions", async () => {
  const view = await render(false, "/remote", "reports/Report.pdf");
  expect((await context(view.element("a"))).defaultPrevented).toBe(true);
  expect(view.host.textContent).not.toContain("Reveal in Finder");
  expect(view.host.textContent).not.toContain("Open with default app");
  await act(async () => view.button("Copy path").click());
  expect(await navigator.clipboard.readText()).toBe("/remote/reports/Report.pdf");
  await context(view.element("a"));
  await act(async () => view.button("Open in panel").click());
  expect(view.opened[0]?.target.value).toBe("reports/Report.pdf");
  expect(view.opened[0]?.options).toBeUndefined();
});

test("copy errors keep the menu available for retry", async () => {
  const view = await render();
  await context(view.element("a"));
  const original = navigator.clipboard.writeText;
  navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  try {
    await act(async () => view.button("Copy path").click());
    expect(view.button("Copy path")).toBeDefined();
    expect(toast.getHistory().some((entry) => "title" in entry && entry.title === "Could not copy the path. Try again.")).toBe(true);
  } finally {
    navigator.clipboard.writeText = original;
  }
});

test("opening with a chosen application hands the desktop the workspace root for on-disk containment", async () => {
  const calls: unknown[][] = [];
  const bridge = window.__OPENWORK_ELECTRON__;
  window.__OPENWORK_ELECTRON__ = {
    invokeDesktop: async (command: string, ...args: unknown[]) => {
      calls.push([command, ...args]);
      if (command === "__getApplicationsForFile") return [{ name: "Preview", appPath: "/Applications/Preview.app", icon: null }];
      return undefined;
    },
  } as unknown as typeof bridge;
  try {
    const view = await render(true, "/secondary", "./reports/Report.pdf");
    await context(view.element("a"));
    for (let attempt = 0; attempt < 10 && !view.host.textContent?.includes("Preview"); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    await act(async () => view.button("Preview").click());
    expect(calls).toContainEqual(["__getApplicationsForFile", "/secondary/reports/Report.pdf"]);
    expect(calls).toContainEqual(["__openWithApp", "/secondary/reports/Report.pdf", "/Applications/Preview.app", "/secondary"]);
  } finally {
    window.__OPENWORK_ELECTRON__ = bridge;
  }
});
