/** @jsxImportSource react */
import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { libraryAddKindsForFilter } from "../src/react-app/domains/settings/library";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { Dialog, DialogContent, DialogTitle } = await import("../src/components/ui/dialog");
const { LibraryAddKindPicker } = await import("../src/react-app/domains/settings/pages/library-add-kind-picker");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

// Bun evaluates every test file in one shared module registry, and Base UI
// decides at import time whether layout effects run. When another file loads
// it before any DOM exists, no dialog can mount for the rest of the run. Probe
// once so this check skips loudly on file order; the focused Library command
// still runs it.
async function dialogLayerCanOpen() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(
    <Dialog open>
      <DialogContent><DialogTitle>dialog-probe</DialogTitle></DialogContent>
    </Dialog>,
  ));
  const opened = document.body.textContent?.includes("dialog-probe") === true;
  await act(async () => root.unmount());
  host.remove();
  return opened;
}
const dialogLayerInert = !(await dialogLayerCanOpen());

describe("Add to your Library picker", () => {
  test("only offers Cloud MCPs, Skills, and Plugins", () => {
    expect(libraryAddKindsForFilter("all")).toEqual(["mcp", "skill", "plugin"]);
    expect(libraryAddKindsForFilter("mcp")).toEqual(["mcp"]);
    expect(libraryAddKindsForFilter("skill")).toEqual(["skill"]);
    expect(libraryAddKindsForFilter("plugin")).toEqual(["plugin"]);
  });

  test.skipIf(dialogLayerInert)("lists those three choices without workspace MCP and dispatches the selected kind", async () => {
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
