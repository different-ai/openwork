/** @jsxImportSource react */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelOption } from "../src/app/types";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ModelPickerPanel } = await import("../src/react-app/domains/models/model-picker-panel");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

const haiku: ModelOption = { providerID: "anthropic", modelID: "haiku", title: "Haiku 5.5", description: "Anthropic", behaviorTitle: "Effort", behaviorLabel: "Medium", behaviorDescription: "", behaviorValue: "medium",
  behaviorOptions: [{ value: "low", label: "Low" }, { value: "medium", label: "Medium" }, { value: "high", label: "High" }], isFree: false };

test("a panel opened on effort lists the levels, focuses the current one and closes on a choice", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  const onBehaviorChange = mock((value: string | null) => {});
  const onEffortChosen = mock(() => {});
  const focus = { current: null as HTMLButtonElement | null };
  await act(async () => root.render(<ModelPickerPanel options={[haiku]} current={haiku} behaviorValue="medium" onSelect={() => {}} onBehaviorChange={onBehaviorChange}
    catalogState={{ state: "ready" }} autoVisible={false} startOnEffort onEffortChosen={onEffortChosen} effortFocusRef={focus} />));
  expect(host.querySelector('[data-slot="model-thinking-submenu"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Search all models"]')).toBeNull();
  expect(focus.current?.textContent).toBe("Medium");
  const high = [...host.querySelectorAll("button")].find((button) => button.textContent === "High");
  await act(async () => high?.click());
  expect(onBehaviorChange).toHaveBeenCalledWith("high");
  expect(onEffortChosen).toHaveBeenCalledTimes(1);
});
