import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { ModelOption } from "../src/app/types";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let mobile = true;
mock.module("../src/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));
mock.module("../src/react-app/shell/workspace-provider", () => ({ useWorkspace: () => ({ client: null }) }));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => () => false }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ isSignedIn: false }) }));
mock.module("../src/react-app/kernel/platform", () => ({ usePlatform: () => ({ os: "macos" }) }));
mock.module("../src/react-app/infra/provider-list-query", () => ({
  useProviderListQuery: () => ({ data: undefined, refetch: () => {} }),
  getConnectedProviderItems: () => [],
}));
const { createRoot } = await import("react-dom/client");
const { ModelSelect } = await import("../src/components/model-select");
const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");

const options: ModelOption[] = [
  { providerID: "local", modelID: "one", title: "One", isFree: false },
  { providerID: "local", modelID: "two", title: "Two", isFree: false,
    behaviorOptions: [{ value: "high", label: "High" }], behaviorValue: "high" },
];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChange = mock(() => {});
function Harness() {
  const [open, setOpen] = useState(false);
  return <ModelSelect open={open} onOpenChange={setOpen} value={options[0]}
    fallbackOptions={options} onChange={onChange} onBehaviorChange={() => {}} />;
}
function button(label: string, within: ParentNode = document) {
  const result = [...within.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function settleFocus() { await act(async () => { await new Promise(requestAnimationFrame); }); }
beforeEach(async () => {
  mobile = true;
  onChange.mockClear();
  useModelCollectionsStore.setState({ favorites: [], recent: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await click(button("Change model"));
  await settleFocus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("mobile Model Back restores its root control without focusing search", async () => {
  await click(button("ModelOne"));
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search models..."]');
  expect(input).not.toBeNull();
  for (const style of ["text-base", "sm:text-base", "md:text-base", "lg:text-sm"]) {
    expect(input?.classList.contains(style)).toBe(true);
  }
  expect(document.activeElement).toBe(button("Model"));
  await click(button("Model"));
  expect(document.activeElement).toBe(button("ModelOne"));
  expect(onChange).not.toHaveBeenCalled();
});

test("desktop model search still receives focus on entry", async () => {
  mobile = false;
  await click(button("ModelOne"));
  expect(document.activeElement).toBe(document.querySelector('input[placeholder="Search models..."]'));
});

test("effort Back remembers the Favorites pane instead of jumping to models", async () => {
  await act(async () => useModelCollectionsStore.setState({ favorites: [options[1]] }));
  const favorites = [...document.querySelectorAll<HTMLButtonElement>('[data-slot="model-select-root"] button')]
    .find((element) => element.textContent?.startsWith("Favorites"));
  if (!favorites) throw new Error("Missing Favorites control");
  await click(favorites);
  await click(button("Two"));
  await click(button("EffortTwo"));
  expect(document.querySelector('[data-slot="model-favorites-submenu"]')).not.toBeNull();
  expect(document.activeElement).toBe(button("Favorites"));
  expect(onChange).not.toHaveBeenCalled();
});

test("effort Back returns to models, and selection closes with trigger focus", async () => {
  await click(button("ModelOne"));
  const item = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.includes("Two"));
  if (!item) throw new Error("Missing model Two");
  await click(item);
  const back = button("EffortTwo");
  expect(document.activeElement).toBe(back);
  await click(back);
  expect(document.activeElement).toBe(button("Model"));
  const one = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.includes("One"));
  if (!one) throw new Error("Missing model One");
  await click(one);
  await settleFocus();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button("Change model"));
  await click(button("Change model"));
  expect(document.querySelector('[data-slot="model-select-root"]')).not.toBeNull();
});
