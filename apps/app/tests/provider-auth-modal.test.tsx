import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { ProviderAuthModalProps } from "../src/react-app/domains/connections/provider-auth/provider-auth-modal";
import type { ProviderAuthMethod } from "../src/react-app/domains/connections/provider-auth/store";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { default: ProviderAuthModal } = await import("../src/react-app/domains/connections/provider-auth/provider-auth-modal");
const { resolveGatewayProviderIds } = await import("../src/react-app/domains/connections/provider-auth/cloud-provider-config");
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

const importedCloudProviders = {
  ipr_openai: { providerId: "gateway-openai", sourceProviderId: "openai", source: "openwork_gateway" },
  ipr_anthropic: { providerId: "gateway-anthropic", sourceProviderId: "anthropic", source: "openwork_gateway" },
  lpr_custom: { providerId: "custom-endpoint", sourceProviderId: "openai", source: "custom" },
};
const gatewayProviderIds = resolveGatewayProviderIds(importedCloudProviders);
const apiMethods: ProviderAuthMethod[] = [{ type: "api", label: "API key", methodIndex: 0 }];
const gatewayMethods: ProviderAuthMethod[] = [
  { type: "api", label: "Managed credential", methodIndex: 0 },
  { type: "oauth", label: "Managed sign-in", methodIndex: 1 },
];

function createProps(): ProviderAuthModalProps {
  return {
    open: true,
    loading: false,
    submitting: false,
    error: null,
    providers: [
      { id: "gateway-openai", name: "Managed OpenAI", env: [] },
      { id: "openai", name: "OpenAI", env: [] },
      { id: "anthropic", name: "Anthropic", env: [] },
      { id: "custom-endpoint", name: "Custom endpoint", env: [] },
      { id: "google", name: "Google", env: [] },
    ],
    connectedProviderIds: ["gateway-openai", "gateway-anthropic", "openai", "anthropic", "custom-endpoint"],
    gatewayProviderIds,
    authMethods: {
      "gateway-openai": gatewayMethods,
      "gateway-anthropic": gatewayMethods,
      openai: apiMethods,
      anthropic: apiMethods,
      "custom-endpoint": apiMethods,
      google: apiMethods,
    },
    onSelect: mock(async () => ({ methodIndex: 1, authorization: { url: "", method: "auto", instructions: "" } })),
    onSubmitApiKey: mock(async () => undefined),
    onSubmitOAuth: mock(async () => ({ connected: false })),
    onClose: mock(() => {}),
  };
}

describe("connect providers gateway visibility", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  function dialog() {
    const element = document.querySelector('[role="dialog"]');
    if (!element) throw new Error("Expected the connect providers dialog");
    return element;
  }

  function providerButton(id: string) {
    return [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      [...button.querySelectorAll("div")].some((element) => element.textContent === id),
    );
  }

  test("OpenWork Models is the first included non-credential row even when a legacy caller requests promotion", async () => {
    const props = createProps();
    await act(async () => root.render(<ProviderAuthModal {...props} openWorkModelsState="included" organizationName="Example Team" organizationProviderCount={2} organizationProviderIds={new Set(["google"])} />));
    const included = dialog().querySelector('[data-testid="included-openwork-provider"]');
    expect(included?.textContent).toContain("OpenWork Models");
    expect(included?.textContent).toContain("Included");
    expect(included?.querySelector("button")).toBeNull();
    expect(dialog().textContent).not.toContain("Subscribe");
    expect(dialog().textContent).toContain("2 providers from Example Team");
    expect(providerButton("google")?.textContent).toContain("Also available from Example Team");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  test("hides runtime gateway IDs while retaining same-vendor direct and custom connected providers", async () => {
    await act(async () => root.render(<ProviderAuthModal {...createProps()} />));

    expect(providerButton("gateway-openai")).toBeUndefined();
    expect(providerButton("gateway-anthropic")).toBeUndefined();
    for (const id of ["openai", "anthropic", "custom-endpoint"]) {
      expect(providerButton(id)?.textContent).toContain("Connected");
    }
    expect(providerButton("google")?.textContent).toContain("Connect");
    expect(providerButton("google")?.textContent).not.toContain("Connected");
    expect(dialog().textContent).toContain("Available to add");
  });

  test("labels OAuth providers Login while API-key providers keep Connect", async () => {
    const props = createProps();
    props.connectedProviderIds = [];
    props.authMethods.openai = [{ type: "oauth", label: "Account sign-in", methodIndex: 0 }];
    await act(async () => root.render(<ProviderAuthModal {...props} />));
    expect(providerButton("openai")?.textContent).toContain("Login");
    expect(providerButton("google")?.textContent).toContain("Connect");
    expect(providerButton("google")?.textContent).not.toContain("Login");
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  test.each(["gateway-openai", "Managed OpenAI", "Managed credential"])("search cannot surface gateway providers by %s", async (query) => {
    const props = createProps();
    await act(async () => root.render(<ProviderAuthModal {...props} />));
    const input = dialog().querySelector<HTMLInputElement>('input[placeholder="Filter providers by name or ID"]');
    if (!input) throw new Error("Expected the provider search input");
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // Also exercise React's input-event fallback when another isolated test
      // loaded react-dom before Happy DOM registered its document.
      input.dispatchEvent(new KeyboardEvent("keyup", { key: query.slice(-1), bubbles: true }));
    });

    expect(dialog().textContent).toContain("No providers match your search.");
    expect(providerButton("gateway-openai")).toBeUndefined();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("No providers match your search.");
  });

  test("does not auto-open a preferred gateway provider", async () => {
    const props = createProps();
    await act(async () => root.render(<ProviderAuthModal {...props} preferredProviderId="gateway-openai" />));

    expect(dialog().querySelector('input[placeholder="Filter providers by name or ID"]')).not.toBeNull();
    expect(dialog().textContent).not.toContain("Choose how you'd like to connect.");
    expect(dialog().textContent).not.toContain("Managed OpenAI");
    expect(providerButton("openai")).toBeDefined();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  test("keeps existing entries when gateway IDs are omitted and updates when they arrive", async () => {
    const props = createProps();
    await act(async () => root.render(<ProviderAuthModal {...props} gatewayProviderIds={undefined} />));
    expect(providerButton("gateway-openai")?.textContent).toContain("Connected");
    expect(providerButton("gateway-anthropic")?.textContent).toContain("Connected");

    await act(async () => root.render(<ProviderAuthModal {...props} />));
    expect(providerButton("gateway-openai")).toBeUndefined();
    expect(providerButton("gateway-anthropic")).toBeUndefined();
    expect(providerButton("custom-endpoint")?.textContent).toContain("Connected");
  });

  test("does not render an empty connected group when only gateway providers are connected", async () => {
    await act(async () => root.render(
      <ProviderAuthModal {...createProps()} connectedProviderIds={[...gatewayProviderIds]} />,
    ));

    expect(dialog().textContent).not.toContain("Connected");
    expect(dialog().textContent).not.toContain("All providers");
    expect(providerButton("openai")).toBeDefined();
    expect(providerButton("gateway-openai")).toBeUndefined();
  });

  test("provider Back restores the selected row, not search, and leaves credentials untouched", async () => {
    const props = createProps();
    await act(async () => root.render(<ProviderAuthModal {...props} />));
    // Base UI queues opening focus to the next animation frame.
    await act(async () => { await new Promise(requestAnimationFrame); });
    const search = dialog().querySelector("input");
    expect(search?.classList.contains("text-base")).toBe(true);
    expect(search?.classList.contains("lg:text-[13px]")).toBe(true);
    await act(async () => providerButton("google")?.click());
    expect(document.activeElement?.textContent).toBe("Connect a provider");
    const keyInput = dialog().querySelector("input");
    expect(keyInput?.classList.contains("text-base")).toBe(true);
    expect(keyInput?.classList.contains("lg:text-sm")).toBe(true);
    const back = [...dialog().querySelectorAll("button")].find((button) => button.textContent?.trim() === "Back");
    await act(async () => back?.click());
    expect(document.activeElement).toBe(providerButton("google"));
    expect(dialog().querySelector('input[type="password"]')).toBeNull();
    // The row's keyboard action must still select that row after resetState.
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(dialog().textContent).toContain("Google");
    expect(dialog().querySelector('input[placeholder="Filter providers by name or ID"]')).toBeNull();
    expect(props.onSubmitApiKey).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  test.each([390, 1280])("opening focus at %ipx respects the mobile keyboard", async (width) => {
    const matchMedia = window.matchMedia.bind(window);
    const mediaSpy = spyOn(window, "matchMedia").mockImplementation((query) => {
      const result = matchMedia(query);
      if (query === "(max-width: 1023px)") Object.defineProperty(result, "matches", { value: width < 1024 });
      return result;
    });
    try {
      expect(window.matchMedia("(max-width: 1023px)").matches).toBe(width < 1024);
      await act(async () => root.render(<ProviderAuthModal {...createProps()} />));
      await act(async () => { await new Promise(requestAnimationFrame); });
      expect(document.activeElement?.getAttribute("data-slot")).toBe(width < 1024 ? "dialog-title" : null);
      if (width >= 1024) expect(document.activeElement?.tagName).toBe("INPUT");
    } finally {
      mediaSpy.mockRestore();
    }
  });

  test("nested method Back stays in the dialog, then returns to its provider row", async () => {
    const props = createProps();
    props.authMethods.google = [
      { type: "api", label: "API key", methodIndex: 0 },
      { type: "oauth", label: "Sign in", methodIndex: 1 },
    ];
    await act(async () => root.render(<ProviderAuthModal {...props} />));
    await act(async () => { await new Promise(requestAnimationFrame); });
    await act(async () => providerButton("google")?.click());
    const api = [...dialog().querySelectorAll("button")].find((button) => button.textContent?.startsWith("API key"));
    await act(async () => api?.click());
    for (const expected of ["Choose how you'd like to connect.", "Filter providers by name or ID"]) {
      const back = [...dialog().querySelectorAll("button")].find((button) => button.textContent?.trim() === "Back");
      await act(async () => back?.click());
      expect(dialog().contains(document.activeElement)).toBe(true);
      expect(document.activeElement?.tagName).not.toBe("INPUT");
      if (expected.startsWith("Choose")) expect(dialog().textContent).toContain(expected);
      else expect(document.activeElement).toBe(providerButton("google"));
    }
  });
});
