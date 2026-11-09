/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderAuthModalProps } from "../src/react-app/domains/connections/provider-auth/provider-auth-modal";
import type { AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import { CLAUDE_AGENT_ROLLOUT_REASON, type ClaudeAgentSetupState } from "../src/app/lib/claude-agent";

const ownedDom = !GlobalRegistrator.isRegistered;
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost:5173/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createRoot } = await import("react-dom/client");
const { AiSettingsView } = await import("../src/react-app/domains/settings/pages/ai-view");
const { default: ProviderAuthModal } = await import("../src/react-app/domains/connections/provider-auth/provider-auth-modal");
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; });
afterAll(async () => { Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct); if (ownedDom) await GlobalRegistrator.unregister(); });
const setup: ClaudeAgentSetupState = {
  enabled: true, blockedReason: null, busy: false, error: null, catalogError: null,
  integration: { id: "claude-agent", name: "Claude Agent", methods: [{ id: "claude-login", type: "external", label: "Connect Claude Code" }], connections: [] },
};
const props: ProviderAuthModalProps = {
  open: true, loading: false, submitting: false, error: null, preferredProviderId: "claude-agent",
  providers: [{ id: "claude-agent", name: "Claude Agent", env: [] }, { id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] }],
  connectedProviderIds: [], authMethods: { "claude-agent": [{ type: "external", label: "Connect Claude Code" }], anthropic: [{ type: "api", label: "API key" }] },
  claudeAgent: setup,
  onSelect: async () => { throw new Error("External setup must not start OAuth"); },
  onSubmitApiKey: async () => { throw new Error("External setup must not accept a key"); },
  onSubmitOAuth: async () => { throw new Error("External setup must not submit OAuth"); }, onClose: () => {},
};
async function mount(overrides: Partial<ProviderAuthModalProps> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<ProviderAuthModal {...props} {...overrides} />); });
  // The preferred entry opens through the same action as selecting the provider.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}

test("Claude setup has installation, command and explicit actions, never a secret field or automatic POST", async () => {
  let connects = 0; let checks = 0;
  await mount({ onConnectClaudeAgent: async () => { connects += 1; }, onRefreshClaudeAgent: async () => { checks += 1; } });
  expect(document.body.textContent).toContain("claude auth login");
  expect(document.body.textContent).toContain("Install Claude Code");
  expect(document.body.textContent).toContain("After running claude auth login there, select Connect Claude Code");
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Paste your API key");
  expect(connects).toBe(0);
  await act(async () => button("Connect Claude Code").click());
  expect(connects).toBe(1);
  await act(async () => button("Check again").click());
  expect(checks).toBe(1);
  expect(document.body.textContent).not.toContain("Verified");
});

test("feature-off setup remains present with the owner and no connect action", async () => {
  await mount({ claudeAgent: { ...setup, enabled: false, blockedReason: CLAUDE_AGENT_ROLLOUT_REASON } });
  expect(document.body.textContent).toContain("Claude Agent");
  expect(document.body.textContent).toContain("administrator can enable it");
  expect(document.body.querySelector('[data-testid="claude-agent-setup"]')?.textContent).not.toContain("Copy command");
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

test("a legacy metadata error does not appear as a Claude setup failure", async () => {
  await mount({ error: "Legacy provider backend is unavailable", onConnectClaudeAgent: async () => {} });
  expect(document.body.textContent).not.toContain("Legacy provider backend is unavailable");
  expect(button("Connect Claude Code").disabled).toBe(false);
});

test("native needs_auth is shown without claiming verified authentication", async () => {
  await mount({ claudeAgent: { ...setup, integration: { ...setup.integration!, connections: [{ type: "credential", id: "reference", label: "Claude Code", method: "external", status: { status: "needs_auth", message: "Claude Code needs sign-in on this device" } }] } } });
  expect(document.body.textContent).toContain("Claude Code needs sign-in on this device");
  expect(document.body.textContent).not.toContain("Verified");
});

test("Anthropic still opens the separate manual API-key form", async () => {
  await mount({ preferredProviderId: "anthropic" });
  expect(document.body.textContent).toContain("Anthropic");
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(button("Save key").disabled).toBe(true);
  expect(document.querySelector('[data-testid="claude-agent-setup"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Claude Pro/Max");
});

const aiProps: AiSettingsViewProps = {
  busy: false, providerAuthBusy: false, providerStatusLabel: "", providerStatusStyle: "", providerSummary: "",
  providerLoadState: { status: "ready", error: null }, onRetryProviders: () => {}, connectedProviders: [], disconnectingProviderId: null,
  providerConnectError: null, providerDisconnectStatus: null, providerDisconnectError: null, onOpenProviderAuth: () => {},
  onDisconnectProvider: () => {}, canDisconnectProvider: () => true, canAddProviders: true, autoSwitchedOff: true,
};
test("native setup remains reachable when the legacy provider backend is unavailable", () => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<AiSettingsView {...aiProps} providerLoadState={{ status: "error", error: "Legacy catalog unavailable" }} claudeAgent={setup} />);
  const connect = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("Connect a provider"));
  expect(connect?.disabled).toBe(false);
  expect(container.textContent).toContain("Other provider settings could not be loaded.");

  container.innerHTML = renderToStaticMarkup(<AiSettingsView {...aiProps} providerLoadState={{ status: "error", error: "Legacy catalog unavailable" }} />);
  const legacyConnect = [...container.querySelectorAll("button")].find((element) => element.textContent?.includes("Connect a provider"));
  expect(legacyConnect?.disabled).toBe(true);
});

test("Settings preserves the native device row even when the engine has no models", () => {
  const markup = renderToStaticMarkup(<AiSettingsView {...aiProps} claudeAgent={{ ...setup, integration: { ...setup.integration!, connections: [{ type: "credential", id: "saved", label: "Claude Code", method: "external" }] } }} />);
  expect(markup).toContain("local-provider-claude-agent");
  expect(markup).toContain("Connection saved");
  expect(markup).toContain("Disconnect");
  expect(markup).not.toContain("Ready to use");
});
