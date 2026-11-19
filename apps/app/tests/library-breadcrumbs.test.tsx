/** @jsxImportSource react */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LibraryBreadcrumbs } from "../src/react-app/design-system/library-breadcrumbs";
import { ExtensionDetailModal } from "../src/react-app/design-system/extension-detail-modal";

let createRoot: typeof import("react-dom/client")["createRoot"];
const ownedDom = !GlobalRegistrator.isRegistered && typeof document === "undefined";
let root: Root | null = null;
let previousAct: unknown;

beforeAll(async () => {
  if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
  createRoot = (await import("react-dom/client")).createRoot;
});
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
beforeEach(() => {
  previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
});

test("ancestors are separate keyboard-accessible buttons and the current skill is not clickable", async () => {
  const visits: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<LibraryBreadcrumbs items={[
    { label: "Library", onClick: () => { visits.push("library"); } },
    { label: "Review toolkit", onClick: () => { visits.push("plugin"); } },
    { label: "Review notes" },
  ]} />));

  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.map(button => button.textContent)).toEqual(["Library", "Review toolkit"]);
  expect(host.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Review notes");
  expect(host.querySelector("nav")?.getAttribute("aria-label")).toBeTruthy();
  expect(host.querySelectorAll('li[aria-hidden="true"]')).toHaveLength(2);
  await act(async () => buttons[1]?.click());
  expect(visits).toEqual(["plugin"]);
  await act(async () => buttons[0]?.click());
  expect(visits).toEqual(["plugin", "library"]);
});

test("detail pages keep the old back button when no breadcrumb rollout is supplied", async () => {
  let closed = 0;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ExtensionDetailModal
    open onClose={() => { closed += 1; }} name="Review notes" description="Review supplied notes."
    taxonomy="skill" presentation="page"
  />));
  expect(host.querySelector("nav")).toBeNull();
  const back = [...host.querySelectorAll("button")].find(button => button.textContent === "Library");
  expect(back).toBeDefined();
  await act(async () => back?.click());
  expect(closed).toBe(1);
});

test("detail breadcrumbs open the parent instead of invoking the root close action", async () => {
  const visits: string[] = [];
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(<ExtensionDetailModal
    open onClose={() => { visits.push("close"); }} name="Review notes" description="Review supplied notes."
    taxonomy="skill" presentation="page"
    breadcrumbs={[
      { label: "Library", onClick: () => { visits.push("library"); } },
      { label: "Review toolkit", onClick: () => { visits.push("plugin"); } },
    ]}
  />));
  expect(host.querySelector('[aria-current="page"]')?.textContent).toBe("Review notes");
  const parent = [...host.querySelectorAll("nav button")].find(button => button.textContent === "Review toolkit");
  await act(async () => parent?.click());
  expect(visits).toEqual(["plugin"]);
});

test("a long current name can truncate without hiding the parent actions", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const name = "A very long skill name ".repeat(12);
  await act(async () => root?.render(<LibraryBreadcrumbs items={[
    { label: "Library", onClick: () => undefined },
    { label: "Skills", onClick: () => undefined },
    { label: name },
  ]} />));
  const current = host.querySelector('[aria-current="page"]');
  expect(current?.textContent).toBe(name);
  expect(current?.classList.contains("truncate")).toBe(true);
  expect(host.querySelectorAll("button")).toHaveLength(2);
});
