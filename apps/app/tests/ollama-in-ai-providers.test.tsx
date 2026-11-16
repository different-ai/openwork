/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { getGlobalSettingsTabs, isSettingsTabActive } = await import("../src/react-app/domains/settings/shell/settings-page");
const { buildCommandPaletteSettingsItems } = await import("../src/react-app/shell/command-palette-settings");
const { AiSettingsView } = await import("../src/react-app/domains/settings/pages/ai-view");
type AiSettingsViewProps = import("../src/react-app/domains/settings/pages/ai-view").AiSettingsViewProps;

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("the sidebar drops Ollama and highlights AI Providers while the Ollama page is open", () => {
  const tabs = getGlobalSettingsTabs(false, { autoUpdate: false });
  expect(tabs).not.toContain("ollama");
  expect(tabs).toContain("ai");
  expect(isSettingsTabActive("ollama", "ai")).toBe(true);
  expect(isSettingsTabActive("ollama", "ollama")).toBe(false);
  expect(isSettingsTabActive("appearance", "ai")).toBe(false);
});

test("the command palette still finds the Ollama page", () => {
  const items = buildCommandPaletteSettingsItems({
    developerMode: false,
    capabilities: { autoUpdate: false },
    onOpenSettings: () => {},
    onOpenExtensions: () => {},
  });
  expect(items.some((item) => item.id === "settings:ollama")).toBe(true);
});

const view: AiSettingsViewProps = {
  busy: false,
  providerAuthBusy: false,
  providerStatusLabel: "",
  providerStatusStyle: "",
  providerSummary: "",
  providerLoadState: { status: "ready", error: null },
  onRetryProviders: () => {},
  connectedProviders: [],
  disconnectingProviderId: null,
  providerConnectError: null,
  providerDisconnectStatus: null,
  providerDisconnectError: null,
  onOpenProviderAuth: () => {},
  onDisconnectProvider: () => {},
  canDisconnectProvider: () => true,
  canAddProviders: true,
};

test("Ollama is always listed on this device with Configure, and there is no separate Use Ollama button", () => {
  expect(renderToStaticMarkup(<AiSettingsView {...view} />)).not.toContain("configure-provider-ollama");
  const notSetUp = renderToStaticMarkup(<AiSettingsView {...view} onConfigureOllama={() => {}} />);
  expect(notSetUp).toContain("local-provider-ollama-setup");
  expect(notSetUp).toContain("Not set up");
  expect(notSetUp).toContain(">Configure<");
  expect(notSetUp).not.toContain("Use Ollama");
});

test("a set-up Ollama keeps its row with Configure next to Disconnect", () => {
  const markup = renderToStaticMarkup(<AiSettingsView {...view} connectedProviders={[{ id: "ollama", name: "Ollama (local)", source: "config" }]} onConfigureOllama={() => {}} />);
  expect(markup).toContain("local-provider-ollama\"");
  expect(markup).toContain("configure-provider-ollama");
  expect(markup).not.toContain("local-provider-ollama-setup");
});

test("a hidden Ollama row offers Configure instead of Enable; LM Studio keeps Enable", () => {
  const disabledProviders = [{ id: "ollama", name: "ollama" }, { id: "lmstudio", name: "lmstudio" }];
  const markup = renderToStaticMarkup(<AiSettingsView {...view} disabledProviders={disabledProviders} onEnableProvider={() => {}} onConfigureOllama={() => {}} />);
  expect(markup.match(/configure-provider-ollama/g)?.length).toBe(1);
  expect(markup).toContain("Enable");
  expect(markup).not.toContain("local-provider-ollama-setup");
});

test("when local models are blocked, no Ollama row is added", () => {
  const markup = renderToStaticMarkup(<AiSettingsView {...view} disabledProviders={[{ id: "ollama", name: "ollama" }]} onEnableProvider={() => {}} />);
  expect(markup).not.toContain("configure-provider-ollama");
  expect(markup).not.toContain("local-provider-ollama-setup");
});
