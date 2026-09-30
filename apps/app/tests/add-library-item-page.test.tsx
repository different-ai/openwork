/** @jsxImportSource react */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { AddLibraryItemPage } = await import("../src/react-app/domains/settings/pages/add-library-item-page");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function mount(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  return host;
}

function buttonNamed(host: HTMLElement, text: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes(text));
}

describe("Library create pages", () => {
  test("Create a skill is a page with one title, not a dialog", async () => {
    const host = await mount(<AddLibraryItemPage kind="skill" cloud onClose={() => {}} onCreate={async () => "plugin-1"} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Create a skill");
    expect(host.textContent).not.toContain("Saved to your organization Library");
    expect(buttonNamed(host, "Create skill")).toBeDefined();
  });

  test("Back to Library, Cancel and Escape all leave the page", async () => {
    const onClose = mock(() => {});
    const host = await mount(<AddLibraryItemPage kind="skill" cloud onClose={onClose} onCreate={async () => "plugin-1"} />);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Back to Library"]')?.click());
    await act(async () => buttonNamed(host, "Cancel")?.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  test("an MCP server asks how it signs in and starts just for you", async () => {
    const host = await mount(
      <AddLibraryItemPage kind="mcp" cloud canConfigureMcpConnections onClose={() => {}} onCreate={async () => "plugin-1"} />,
    );
    expect(host.querySelector("h1")?.textContent).toBe("Add an MCP server");
    const signIn = host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="How does it sign in?"]');
    const options = [...(signIn?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];
    expect(options.map((option) => option.querySelector("span > span")?.textContent)).toEqual(["With my account", "With a key", "No sign-in"]);
    expect(options[0]?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Only you can use it until you share it.");
    expect(host.textContent).not.toContain("Everyone in the organization");
    expect(buttonNamed(host, "Add and sign in")).not.toBeUndefined();
    await act(async () => buttonNamed(host, "No sign-in")?.click());
    expect(buttonNamed(host, "Add MCP")).not.toBeUndefined();
  });

  test("choosing a key shows the key field", async () => {
    const host = await mount(
      <AddLibraryItemPage kind="mcp" cloud canConfigureMcpConnections onClose={() => {}} onCreate={async () => "plugin-1"} />,
    );
    expect(host.querySelector('input[type="password"]')).toBeNull();
    await act(async () => buttonNamed(host, "With a key")?.click());
    expect(host.querySelector('input[type="password"]')).not.toBeNull();
  });
});
