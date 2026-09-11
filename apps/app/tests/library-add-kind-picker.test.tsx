/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { libraryAddKindsForFilter } from "../src/react-app/domains/settings/library";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { LibraryAddKindPicker } = await import("../src/react-app/domains/settings/pages/library-add-kind-picker");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

describe("Add to your Library picker", () => {
  test("only offers Cloud MCPs, Skills, and Plugins and dispatches the selected kind", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onSelect = mock(() => {});
    try {
      await act(async () => root.render(<LibraryAddKindPicker open kinds={libraryAddKindsForFilter("all")} onClose={() => {}} onSelect={onSelect} />));
      const choices = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
      expect(choices.map((choice) => choice.dataset.kind)).toEqual(["mcp", "skill", "plugin"]);
      expect(document.body.textContent).not.toContain("workspace MCP");
      await act(async () => choices[2].click());
      expect(choices[2].getAttribute("aria-checked")).toBe("true");
      const continueButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue");
      expect(continueButton).toBeDefined();
      await act(async () => continueButton?.click());
      expect(onSelect).toHaveBeenCalledWith("plugin");
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
