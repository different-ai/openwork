import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useState } from "react";
import type { ModelOption } from "../src/app/types";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let mobile = false;
mock.module("../src/hooks/use-mobile", () => ({ useIsMobile: () => mobile }));
mock.module("../src/react-app/shell/workspace-provider", () => ({
  useWorkspace: () => ({ client: null, opencodeBaseUrl: "", selectedWorkspaceRoot: "", workspaceId: "" }),
  useWorkspaceMaybe: () => undefined,
}));
mock.module("../src/react-app/infra/provider-list-query", () => ({
  useProviderListQuery: () => ({ data: undefined, refetch: async () => undefined, isError: false, isPending: false, isFetching: false, dataUpdatedAt: 0, error: null }),
  getConnectedProviderItems: () => [],
}));
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const auth = await import("../src/react-app/domains/cloud/den-auth-provider");
const policy = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { ModelSelect } = await import("../src/components/model-select");
const { useModelCollectionsStore } = await import("../src/react-app/domains/session/models/model-collections-store");

const options: ModelOption[] = [
  { providerID: "local", modelID: "one", title: "One", description: "Local", isFree: false, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null,
    behaviorOptions: [{ value: null, label: "Default", description: "" }, { value: "high", label: "High", description: "" }] },
  { providerID: "local", modelID: "two", title: "Two", description: "Local", isFree: false, behaviorTitle: "Effort", behaviorLabel: "Default", behaviorDescription: "", behaviorValue: null },
];
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queries: InstanceType<typeof QueryClient>;
let restore: Array<() => void> = [];
const onChange = mock(() => {});
function Harness() {
  const [open, setOpen] = useState(false);
  return <ModelSelect open={open} onOpenChange={setOpen} value={options[0]} fallbackOptions={options} onChange={onChange} onBehaviorChange={() => {}} />;
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.trim() === label || item.getAttribute("aria-label") === label || item.textContent?.startsWith(label));
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function settleFocus() { await act(async () => { await new Promise(requestAnimationFrame); }); }
async function open() {
  await act(async () => root.render(<PlatformProvider value={createDefaultPlatform()}><QueryClientProvider client={queries}><Harness /></QueryClientProvider></PlatformProvider>));
  await click(button("Change model"));
  await settleFocus();
}
const search = () => document.querySelector<HTMLInputElement>('input[aria-label="Search all models"]');
beforeEach(() => {
  mobile = false;
  onChange.mockClear();
  const signedOut = spyOn(auth, "useDenAuth").mockReturnValue({ status: "signed_out", user: null, verifiedIdentity: null, isSignedIn: false, error: null, refresh: async () => {} });
  const allowed = spyOn(policy, "useCheckDesktopRestriction").mockReturnValue(() => false);
  restore = [() => signedOut.mockRestore(), () => allowed.mockRestore()];
  useModelCollectionsStore.setState({ favorites: [], recent: [] });
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  queries.clear();
  for (const undo of restore) undo();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("desktop opening focuses model search, with a zoom-safe text size on phones", async () => {
  await open();
  expect(document.activeElement).toBe(search());
  for (const style of ["text-base", "sm:text-base", "md:text-base", "lg:text-sm"]) expect(search()?.classList.contains(style)).toBe(true);
});

test("mobile opening focuses the picker, not search, so the keyboard stays closed", async () => {
  mobile = true;
  await open();
  expect(document.activeElement).not.toBe(search());
  expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-model-picker");
});

test("Effort opens with Back focused and Back returns focus to Effort without changing the model", async () => {
  await open();
  const advanced = document.querySelector<HTMLElement>('[data-testid="model-advanced-options"] summary');
  if (!advanced) throw new Error("Missing Advanced options");
  await click(advanced);
  await click(button("Effort"));
  expect(document.activeElement).toBe(button("Back to models"));
  await click(button("Back to models"));
  expect(document.activeElement).toBe(button("Effort"));
  expect(onChange).not.toHaveBeenCalled();
});

test("choosing another model changes it once and closes the picker", async () => {
  await open();
  const two = document.querySelector<HTMLElement>('[data-model-key="local:two"]');
  if (!two) throw new Error("Missing model Two");
  await click(two);
  await settleFocus();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-testid="composer-model-picker"]')).toBeNull();
});
