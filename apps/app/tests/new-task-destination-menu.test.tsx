/** @jsxImportSource react */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import type { NewTaskDestinationMenu } from "../src/react-app/domains/session/chat/new-task-destination-menu";

const registeredDom = typeof globalThis.document === "undefined";
beforeAll(() => {
  if (registeredDom) GlobalRegistrator.register({ url: "http://localhost/" });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
});
afterAll(async () => { if (registeredDom) await GlobalRegistrator.unregister(); });

async function mount(overrides: Partial<ComponentProps<typeof NewTaskDestinationMenu>> = {}) {
  const { NewTaskDestinationMenu } = await import("../src/react-app/domains/session/chat/new-task-destination-menu");
  const props: ComponentProps<typeof NewTaskDestinationMenu> = {
    destination: { workspaceId: "alpha" },
    workspaces: [{ id: "alpha", label: "Alpha" }],
    groups: [], hasDraft: false, disabled: false,
    onChange: () => {}, onDiscard: () => {},
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<NewTaskDestinationMenu {...props} />));
  return {
    container,
    open: async () => {
      const trigger = container.querySelector<HTMLButtonElement>("button");
      if (!trigger) throw new Error("Expected a menu trigger");
      await act(async () => trigger.click());
    },
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
}

test("one workspace with no groups or draft adds no context control", async () => {
  const ui = await mount();
  try { expect(ui.container.textContent).toBe(""); expect(ui.container.querySelector("button")).toBeNull(); }
  finally { await ui.unmount(); }
});

test("zero groups offers only workspace choices, never a No group placeholder", async () => {
  const ui = await mount({ workspaces: [{ id: "alpha", label: "Alpha" }, { id: "beta", label: "Beta" }] });
  try {
    expect(ui.container.querySelector('[aria-label="Workspace destination"]')?.textContent).toBe("Alpha");
    expect(ui.container.querySelector('[aria-label="Session destination"]')).toBeNull();
    await ui.open();
    expect([...document.querySelectorAll('[role="menuitemradio"]')].map((item) => item.textContent)).toEqual(["Alpha", "Beta"]);
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("No group");
    expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("Ungrouped");
  } finally { await ui.unmount(); }
});

test("groups show the selected group with workspace hierarchy and No group choice", async () => {
  const selections: (string | undefined)[] = [];
  const ui = await mount({
    destination: { workspaceId: "alpha", groupId: "research" },
    groups: [{ id: "research", label: "Research" }],
    onChange: (destination) => selections.push(destination.groupId),
  });
  try {
    expect(ui.container.querySelector('[aria-label="Session destination"]')?.textContent).toBe("Research");
    await ui.open();
    expect(document.querySelector('[data-slot="dropdown-menu-label"]')?.textContent).toBe("Alpha");
    expect(document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent).toBe("Research");
    const noGroup = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) => item.textContent === "No group");
    if (!noGroup) throw new Error("Expected No group choice");
    await act(async () => noGroup.click());
    expect(selections).toEqual([undefined]);
  } finally { await ui.unmount(); }
});

test("a nonempty draft without groups exposes discard only inside Draft actions", async () => {
  let discarded = false;
  const ui = await mount({ hasDraft: true, onDiscard: () => { discarded = true; } });
  try {
    expect(ui.container.querySelector('[aria-label="Draft actions"]')).not.toBeNull();
    expect(ui.container.textContent).not.toContain("Discard draft");
    await ui.open();
    expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
    const discard = document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(discard?.textContent).toContain("Discard draft");
    await act(async () => discard?.click());
    expect(discarded).toBe(true);
  } finally { await ui.unmount(); }
});

test("pending submission locks destination and discard actions", async () => {
  const ui = await mount({ hasDraft: true, disabled: true });
  try { expect(ui.container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true); }
  finally { await ui.unmount(); }
});
