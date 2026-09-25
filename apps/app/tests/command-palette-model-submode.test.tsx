import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import type { ModelOption } from "../src/app/types";

GlobalRegistrator.register({ url: "http://localhost" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
afterAll(async () => { await GlobalRegistrator.unregister(); });
const { createRoot } = await import("react-dom/client");
const { CommandPalette } = await import("../src/react-app/shell/command-palette");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");

for (const surface of ["session", "settings"]) {
  test(`${surface} palette shows current and next models and selects within the shared submode`, async () => {
    const policySpy = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
    const auto: ModelOption = { providerID: "openwork-free", modelID: "openai/gpt-5.6-luna", title: "Luna", isFree: true };
    const next: ModelOption = { providerID: "anthropic", modelID: "specific-model", title: "Friendly model", description: "Anthropic", isFree: false };
    const previous = useModelCollectionsStore.getState();
    useModelCollectionsStore.setState({ favorites: [next], recent: [] });
    const selected: unknown[] = [];
    let closed = 0;
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(createElement(PlatformProvider, { value: createDefaultPlatform(), children:
        createElement(CommandPalette, { open: true, onClose: () => { closed++; }, developerMode: false, sessions: [],
          onCreateNewSession: () => undefined, onOpenSession: () => undefined, onOpenSettings: () => undefined,
          onOpenExtensions: () => undefined, onOpenModelPicker: surface === "settings" ? () => { throw new Error("must stay in palette"); } : undefined,
          modelOptions: [auto, next], selectedModel: auto, selectedModelBehavior: null,
          onSelectModel: (model, behavior) => selected.push({ model, behavior }) }) })));
      await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
      const row = (id: string) => document.querySelector<HTMLElement>(`[data-command-palette-item="${id}"]`);
      expect(row("models")?.textContent).toContain("Auto");
      expect(row("models.next-pinned")?.textContent).toContain("Auto → Friendly model");
      expect(row("models.next-source")?.textContent).toContain("Local");
      await act(async () => row("models")?.click());
      expect(document.querySelector('input[placeholder="Search models…"]')).not.toBeNull();
      expect(row("model:openwork-free:openai/gpt-5.6-luna")?.textContent).toContain("Current");
      const modelRow = row("model:anthropic:specific-model");
      expect(modelRow?.textContent).toContain("Anthropic · specific-model");
      expect(modelRow?.firstElementChild?.getAttribute("data-slot")).toBe("model-provider-mark");
      expect(modelRow?.querySelector('[data-slot="model-source"] svg[aria-label="Local"]')).not.toBeNull();
      const back = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Back");
      expect(back).toBeDefined();
      await act(async () => back?.click());
      expect(row("models")).not.toBeNull();
      expect(selected).toEqual([]);
      await act(async () => row("models")?.click());
      await act(async () => row("model:anthropic:specific-model")?.click());
      expect(selected).toEqual([{ model: { providerID: next.providerID, modelID: next.modelID }, behavior: undefined }]);
      expect(closed).toBe(1);
    } finally {
      await act(async () => root.unmount()); host.remove(); policySpy.mockRestore();
      useModelCollectionsStore.setState({ favorites: previous.favorites, recent: previous.recent });
    }
  });
}
