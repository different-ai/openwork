/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelOption } from "../src/app/types";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const features = await import("../src/react-app/domains/session/status/use-desktop-feature");
const { ModelPickerList } = await import("../src/react-app/domains/models/model-picker-list");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { CommandPalette } = await import("../src/react-app/shell/command-palette");
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function model(providerID: string, modelID: string, title: string, description: string): ModelOption {
  return { providerID, modelID, title, description, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null, behaviorOptions: [], isFree: false };
}
const claude = model("ipr_a", "gwm_a", "Claude Opus 5.5", "OpenWork Anthropic");
const sol = model("ipr_b", "gwm_b", "Sol 6.1", "OpenWork Models");
const unrelated = model("302ai", "claude-opus-6.1", "Claude Opus 6.1", "302.AI");

async function mount(query: string, enabled = true, options = [claude, sol, unrelated]) {
  spyOn(features, "useDesktopFeature").mockImplementation((key) => key === "providerFilterSyncFix" && enabled);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onQueryChange = mock((value: string) => {});
  const render = async (value: string) => {
    await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}><ModelPickerList options={options} current={sol} query={value} onQueryChange={onQueryChange} onSelect={() => {}} autoFocusSearch={false} /></PlatformProvider>));
  };
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  await render(query);
  return { host, render, onQueryChange };
}

test("scoped search shows only models matching both provider terms", async () => {
  const { host } = await mount("ow anthropic");
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(1);
  expect(host.textContent).toContain("Claude Opus 5.5");
  expect(host.textContent).not.toContain("302.AI");
  expect(host.textContent).not.toContain("Sol 6.1");
});

test("an empty scoped match stays empty after a successful search", async () => {
  const { host, render, onQueryChange } = await mount("ow anthropic");
  await render("sol 6.1 ow anthropic");
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(0);
  expect(host.textContent).toContain("No models match “sol 6.1 ow anthropic”");
  expect(host.textContent).not.toContain("Showing other providers");
  expect(host.textContent).not.toContain("isn't connected");
  const recovery = [...host.querySelectorAll("button")].find((button) => button.textContent === "Show all OpenWork Anthropic models");
  expect(recovery).toBeDefined();
  await act(async () => recovery?.click());
  expect(onQueryChange).toHaveBeenCalledWith("ow anthropic");
  await render("ow anthropic");
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(1);
});

test("a provider-only miss never substitutes the unfiltered catalog", async () => {
  const { host } = await mount("ow anthropic", true, [sol, unrelated]);
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(0);
  expect(host.textContent).toContain("No models match “ow anthropic”");
  expect(host.textContent).not.toContain("302.AI");
});

test("each provider is reachable without searching through an aggregator's models", async () => {
  const many = Array.from({ length: 200 }, (_, index) => model("302ai", `model-${index}`, `Aggregator model ${index}`, "302.AI"));
  const { host, onQueryChange } = await mount("", true, [...many, claude, sol]);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Filter models by provider"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const provider = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent?.includes("OpenWork Anthropic"));
  expect(provider).toBeDefined();
  await act(async () => provider?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
  await act(async () => provider?.click());
  expect(onQueryChange).toHaveBeenCalledWith("");
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(1);
  expect(host.textContent).toContain("Claude Opus 5.5");
  expect(host.textContent).not.toContain("Aggregator model");
  await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const all = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === "All providers");
  await act(async () => all?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
  await act(async () => all?.click());
  expect(host.querySelectorAll("[data-model-key]")).toHaveLength(202);
});

test("a device key and the organization's copy of one provider are told apart", async () => {
  const { host } = await mount("", true, [model("openai", "gpt-5", "GPT-5", "OpenAI"), model("ipr_c", "gwm_c", "GPT-5", "OpenAI"), sol]);
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Filter models by provider"]');
  await act(async () => trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  const labels = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"] span.truncate')].map((label) => label.textContent);
  expect(labels).toEqual(["OpenAI · Local", "OpenAI · OpenWork Gateway", "OpenWork Models"]);
  const rows = [...host.querySelectorAll<HTMLElement>("[data-model-key]")].map((row) => row.getAttribute("aria-label") ?? "");
  expect(rows.filter((row) => row.startsWith("GPT-5, OpenAI · Local"))).toHaveLength(1);
  expect(rows.filter((row) => row.startsWith("GPT-5, OpenAI · OpenWork Gateway"))).toHaveLength(1);
});

test("the command palette's Models mode uses the same scoped search and provider navigation", async () => {
  spyOn(features, "useDesktopFeature").mockReturnValue(true);
  spyOn(desktopConfig, "useCheckDesktopRestriction").mockReturnValue(() => ({ allowed: true }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}><CommandPalette open developerMode={false}
    onClose={() => {}} onOpenSession={() => {}} onCreateNewSession={() => {}} onOpenSettings={() => {}} onOpenExtensions={() => {}}
    sessions={[]} modelOptions={[claude, sol, unrelated]} selectedModel={sol} onSelectModel={() => {}} /></PlatformProvider>));
  const models = document.querySelector<HTMLElement>('[data-command-palette-item="models"]');
  expect(models).not.toBeNull();
  await act(async () => models?.click());
  expect(document.querySelector('[data-testid="palette-model-picker"] [aria-label="Filter models by provider"]')).not.toBeNull();
  const input = document.querySelector<HTMLInputElement>('[aria-label="Search all models"]');
  if (!input) throw new Error("Model search input is missing");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const type = async (query: string) => {
    await act(async () => {
      setValue?.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  await type("ow anthropic");
  expect(document.querySelectorAll('[data-testid="palette-model-picker"] [data-model-key]')).toHaveLength(1);
  await type("sol 6.1 ow anthropic");
  expect(document.querySelectorAll('[data-testid="palette-model-picker"] [data-model-key]')).toHaveLength(0);
  expect(document.body.textContent).toContain("Show all OpenWork Anthropic models");
});

test("switching the flag off restores the legacy results", async () => {
  const { host } = await mount("sol 6.1 ow anthropic", false);
  expect(host.querySelectorAll("[data-model-key]").length).toBeGreaterThan(0);
  expect(host.textContent).toContain("Showing other providers");
});
