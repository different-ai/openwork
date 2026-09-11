/** @jsxImportSource react */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { SessionTitleBreadcrumb } from "../src/react-app/domains/session/chat/session-title-breadcrumb";

const sessionPagePath = fileURLToPath(
  new URL("../src/react-app/domains/session/chat/session-page.tsx", import.meta.url),
);

test("hidden Cloud sign-in does not reserve header space", () => {
  const source = readFileSync(sessionPagePath, "utf8");

  expect(source).toContain("{showCloudSignIn ? (");
  expect(source).not.toContain('className={showCloudSignIn ? undefined : "invisible"}');
  expect(source).not.toContain("disabled={!showCloudSignIn}");
});

test("root and takeover headers keep their heading without a parent breadcrumb", () => {
  for (const title of ["Research notes", "Library", "Create or connect workspace"]) {
    const html = renderToStaticMarkup(
      <SessionTitleBreadcrumb parent={null} onOpenParent={() => {}}>
        <h1>{title}</h1>
      </SessionTitleBreadcrumb>,
    );
    expect(html).toBe(`<h1>${title}</h1>`);
  }
});

test("a child header shows parent, chevron, current heading and returns to its parent once", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onOpenParent = mock(() => {});
  const parentTitle = "Research pricing options for the next launch";
  try {
    await act(async () => root.render(
      <SessionTitleBreadcrumb parent={{ sessionId: "parent-session", title: parentTitle }} onOpenParent={onOpenParent}>
        <h1 className="truncate">Compare pricing pages</h1>
      </SessionTitleBreadcrumb>,
    ));
    const nav = container.querySelector('nav[aria-label="Conversation breadcrumb"]');
    const items = nav?.querySelectorAll("ol > li");
    expect(items).toHaveLength(3);
    expect(items?.[0]?.textContent).toBe(parentTitle);
    expect(items?.[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(items?.[1]?.querySelector("[data-session-breadcrumb-separator]")).not.toBeNull();
    expect(items?.[2]?.getAttribute("aria-current")).toBe("page");
    expect(items?.[2]?.querySelector("h1")?.textContent).toBe("Compare pricing pages");
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    const parent = nav?.querySelector<HTMLButtonElement>("[data-parent-session-back]");
    if (!parent) throw new Error("Missing clickable parent breadcrumb");
    expect(parent.getAttribute("data-parent-session-back")).toBe("parent-session");
    expect(parent.getAttribute("aria-label")).toBe(`Back to ${parentTitle}`);
    expect(parent.querySelector("span")?.className).not.toContain("hidden");
    await act(async () => parent.click());
    expect(onOpenParent).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});
