/** @jsxImportSource react */
import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderToStaticMarkup } from "react-dom/server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { getGlobalSettingsTabs, isSettingsTabActive } = await import("../src/react-app/domains/settings/shell/settings-page");
const { AiSettingsView } = await import("../src/react-app/domains/settings/pages/ai-view");
type AiSettingsViewProps = import("../src/react-app/domains/settings/pages/ai-view").AiSettingsViewProps;

afterAll(async () => {
  if (ownedDom) await GlobalRegistrator.unregister();
});

test("off, Ollama stays its own settings page in the sidebar", () => {
  expect(getGlobalSettingsTabs(false, { autoUpdate: false })).toContain("ollama");
  expect(isSettingsTabActive("ollama", "ollama")).toBe(true);
  expect(isSettingsTabActive("ollama", "ai")).toBe(false);
});

test("on, the sidebar drops Ollama and highlights AI Providers while the Ollama page is open", () => {
  const tabs = getGlobalSettingsTabs(false, { autoUpdate: false }, { ollamaInAiProviders: true });
  expect(tabs).not.toContain("ollama");
  expect(tabs).toContain("ai");
  expect(isSettingsTabActive("ollama", "ai", { ollamaInAiProviders: true })).toBe(true);
  expect(isSettingsTabActive("ollama", "ollama", { ollamaInAiProviders: true })).toBe(false);
  expect(isSettingsTabActive("appearance", "ai", { ollamaInAiProviders: true })).toBe(false);
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

test("AI Providers shows Use Ollama only when the page is given a way to open it", () => {
  expect(renderToStaticMarkup(<AiSettingsView {...view} />)).not.toContain("Use Ollama");
  const withButton = renderToStaticMarkup(<AiSettingsView {...view} onUseOllama={() => {}} />);
  expect(withButton).toContain("ai-providers-use-ollama");
  expect(withButton).toContain("Use Ollama");
});
