/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderAuthModalProps } from "../src/react-app/domains/connections/provider-auth/provider-auth-modal";
import type { AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import type { ClaudeAgentSetupState } from "../src/app/lib/claude-agent";

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
  busy: false, checking: false, verified: false, error: null,
  integration: { id: "claude-agent", name: "Claude Agent", methods: [{ id: "claude-login", type: "external", label: "Claude Code login (claude auth login)" }], connections: [] },
};
const connected = (status?: { status: "needs_auth"; message: string }): ClaudeAgentSetupState => ({
  ...setup, integration: { ...setup.integration!, connections: [{ type: "credential", id: "reference", label: "Claude Code", method: "external", ...(status ? { status } : {}) }] },
});
const props: ProviderAuthModalProps = {
  open: true, loading: false, submitting: false, error: null,
  providers: [{ id: "anthropic", name: "Anthropic", env: ["ANTHROPIC_API_KEY"] }, { id: "openai", name: "OpenAI", env: ["OPENAI_API_KEY"] }],
  connectedProviderIds: [],
  authMethods: { anthropic: [{ type: "external", label: "Claude Code" }, { type: "api", label: "API key", methodIndex: 0 }], openai: [{ type: "api", label: "API key", methodIndex: 0 }] },
  claudeAgent: setup,
  onSelect: async () => { throw new Error("Claude Code must not start OAuth"); },
  onSubmitApiKey: async () => { throw new Error("Claude Code must not accept a key"); },
  onSubmitOAuth: async () => { throw new Error("Claude Code must not submit OAuth"); }, onClose: () => {},
};
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
async function mount(overrides: Partial<ProviderAuthModalProps> = {}) {
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  const render = async (next: Partial<ProviderAuthModalProps> = {}) => { await act(async () => { root?.render(<ProviderAuthModal {...props} {...overrides} {...next} />); }); await settle(); };
  await render();
  return render;
}
function button(label: string) {
  const result = [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
const buttons = () => [...document.querySelectorAll("button")].map((element) => element.textContent?.trim() ?? "");
const row = (id: string) => document.querySelector(`[data-provider-id="${id}"]`);
const step = () => document.querySelector('[data-testid="claude-code-setup"]');

test("Claude Code is one of the ways to connect Anthropic, not its own entry in the list", async () => {
  await mount();
  expect(row("claude-agent")).toBeNull();
  expect(row("anthropic")?.textContent).toContain("Sign in with Claude Code or paste an API key");
  expect(row("openai")?.textContent).toContain("Paste an API key");
  await act(async () => (row("anthropic") as HTMLButtonElement).click());
  // The same "choose how to connect" step every provider with two ways uses.
  expect(document.body.textContent).toContain("Choose how you'd like to connect.");
  expect(document.body.textContent).toContain("Use your Claude plan through Claude Code on this computer.");
  expect(step()).toBeNull();
  await act(async () => button("Claude CodeUse your Claude plan through Claude Code on this computer.").click());
  expect(step()).not.toBeNull();
});

test("the Claude Code step has the sign-in command, an install link and one action, never a secret field or an automatic connect", async () => {
  let connects = 0; let closed = 0;
  await mount({ preferredProviderId: "claude-agent", onConnectClaudeAgent: async () => { connects += 1; return "Claude Code connected"; }, onClose: () => { closed += 1; } });
  expect(step()?.textContent).toContain("claude auth login");
  expect(step()?.textContent).toContain("Install Claude Code");
  expect(document.querySelector('input[type="password"]')).toBeNull();
  expect(document.body.textContent).not.toContain("Paste your API key");
  expect(connects).toBe(0);
  // One primary action; nothing next to it to "check" separately.
  expect(buttons().filter((label) => label === "Connect" || label === "Check again" || label === "Connect Claude Code")).toEqual(["Connect"]);
  await act(async () => button("Connect").click());
  await settle();
  expect(connects).toBe(1);
  // A confirmed login ends the flow: the sheet closes.
  expect(closed).toBe(1);
});

test("while the engine checks, the action says so and cannot be pressed again", async () => {
  await mount({ preferredProviderId: "claude-agent", onConnectClaudeAgent: async () => "Claude Code connected", claudeAgent: { ...connected(), busy: true, checking: true } });
  const action = document.querySelector('[data-testid="claude-code-connect"]') as HTMLButtonElement;
  expect(action.textContent).toContain("Checking Claude Code…");
  expect(action.disabled).toBe(true);
  expect(button("Back").disabled).toBe(true);
});

test("a failed check shows the engine's reason and offers to check again, and the sheet stays open", async () => {
  let closed = 0;
  const reason = "Claude Code is not logged in. Run `claude auth login` in a terminal.";
  const render = await mount({ preferredProviderId: "claude-agent", onClose: () => { closed += 1; }, onConnectClaudeAgent: async () => { throw new Error(reason); } });
  await act(async () => button("Connect").click());
  await settle();
  await render({ claudeAgent: { ...connected({ status: "needs_auth", message: reason }), error: reason } });
  expect(document.body.textContent).toContain(reason);
  expect(button("Check again").disabled).toBe(false);
  expect(closed).toBe(0);
  expect(document.body.textContent).not.toContain("Connection saved");
});

test("where OpenWork can open the sign-in, the step is one action with no command to run", async () => {
  let signIns = 0; let closed = 0;
  await mount({
    preferredProviderId: "claude-agent", claudeAgent: { ...setup, canSignIn: true }, onClose: () => { closed += 1; },
    onSignInClaudeAgent: async () => { signIns += 1; return "Claude Code connected"; },
    onConnectClaudeAgent: async () => { throw new Error("Connect must go through the sign-in"); },
  });
  expect(step()?.textContent).toContain("Uses your Claude plan through Claude Code on this computer.");
  expect(step()?.textContent).toContain("Install Claude Code");
  expect(step()?.textContent).not.toContain("claude auth login");
  expect(buttons().filter((label) => label === "Connect" || label === "Sign in again" || label === "Check again" || label === "Copy")).toEqual(["Connect"]);
  await act(async () => button("Connect").click());
  await settle();
  expect(signIns).toBe(1);
  expect(closed).toBe(1);
});

test("while the browser sign-in is open the step says so, and Cancel or closing the sheet stops it", async () => {
  let cancels = 0;
  await mount({
    preferredProviderId: "claude-agent", claudeAgent: { ...setup, canSignIn: true, busy: true, signingIn: true },
    onSignInClaudeAgent: async () => "Claude Code connected", onCancelClaudeAgentSignIn: () => { cancels += 1; },
  });
  expect(document.querySelector('[data-testid="claude-code-waiting"]')?.textContent).toContain("Continue in your browser");
  const action = document.querySelector('[data-testid="claude-code-connect"]') as HTMLButtonElement;
  expect(action.textContent).toContain("Waiting for sign-in…");
  expect(action.disabled).toBe(true);
  expect(button("Back").disabled).toBe(true);
  await act(async () => button("Cancel").click());
  expect(cancels).toBe(1);
  await act(async () => button("Close").click());
  expect(cancels).toBe(2);
});

test("after a failed sign-in the step keeps the reason and offers to sign in again", async () => {
  const reason = "Claude Code is not logged in. Run claude auth login in a terminal.";
  await mount({
    preferredProviderId: "claude-agent", onSignInClaudeAgent: async () => "Claude Code connected",
    claudeAgent: { ...connected({ status: "needs_auth", message: reason }), error: reason, canSignIn: true, installed: true },
  });
  expect(document.body.textContent).toContain(reason);
  expect(button("Sign in again").disabled).toBe(false);
});

const missingCard = () => document.querySelector('[data-testid="claude-code-missing"]');
test("a missing Claude Code is its own state: one action that opens the installer, no error and no Connect", async () => {
  const opened: string[] = [];
  const open = window.open;
  window.open = ((url: string) => { opened.push(url); return null; }) as typeof window.open;
  try {
    let checks = 0;
    const render = await mount({
      preferredProviderId: "claude-agent", onSignInClaudeAgent: async () => "Claude Code connected", onCheckClaudeAgentInstalled: () => { checks += 1; },
      claudeAgent: { ...setup, canSignIn: true, installed: false },
    });
    // Opening the step looks for Claude Code straight away.
    expect(checks).toBeGreaterThan(0);
    expect(missingCard()?.textContent).toContain("Claude Code is not on this computer yet");
    expect(buttons().filter((label) => ["Connect", "Sign in again", "Check again", "Install Claude Code", "Get Claude Code"].includes(label))).toEqual(["Get Claude Code"]);
    await act(async () => button("Get Claude Code").click());
    expect(opened).toEqual(["https://code.claude.com/docs/en/setup"]);
    // The reason the server or the engine gave for it is the same state, not a red error to read.
    await render({ claudeAgent: { ...setup, canSignIn: true, error: "Claude Code is not installed. Install it, then sign in." } });
    expect(missingCard()).not.toBeNull();
    expect(document.body.textContent).not.toContain("Install it, then sign in.");
    await render({ claudeAgent: { ...connected({ status: "needs_auth", message: "Claude Code is not installed. Install it, then run claude auth login." }), canSignIn: true, installed: false } });
    expect(buttons()).toContain("Get Claude Code");
  } finally { window.open = open; }
});

test("coming back to OpenWork looks again, and a Claude Code found since then goes straight to Connect", async () => {
  let checks = 0;
  const overrides = { preferredProviderId: "claude-agent", onSignInClaudeAgent: async () => "Claude Code connected", onCheckClaudeAgentInstalled: () => { checks += 1; } };
  const render = await mount({ ...overrides, claudeAgent: { ...setup, canSignIn: true, installed: false } });
  const before = checks;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(checks).toBe(before + 1);
  await render({ ...overrides, claudeAgent: { ...setup, canSignIn: true, installed: true } });
  expect(missingCard()).toBeNull();
  expect(document.querySelector('[data-testid="claude-code-found"]')?.textContent).toContain("Claude Code is installed");
  expect(buttons().filter((label) => ["Connect", "Get Claude Code", "Install Claude Code"].includes(label))).toEqual(["Connect"]);
  // An engine reason from before the install is out of date, not an error.
  await render({ ...overrides, claudeAgent: { ...connected({ status: "needs_auth", message: "Claude Code is not installed. Install it, then run claude auth login." }), canSignIn: true, installed: true } });
  expect(document.body.textContent).not.toContain("Claude Code is not installed.");
  expect(button("Check again").disabled).toBe(false);
});

test("where OpenWork cannot look for Claude Code, the step never asks and keeps its install link", async () => {
  let checks = 0;
  await mount({ preferredProviderId: "claude-agent", onConnectClaudeAgent: async () => "Claude Code connected", onCheckClaudeAgentInstalled: () => { checks += 1; } });
  expect(checks).toBe(0);
  expect(buttons()).toContain("Install Claude Code");
});

test("the engine's provider list failing does not show up as a Claude Code failure", async () => {
  await mount({ preferredProviderId: "claude-agent", error: "Legacy provider backend is unavailable", onConnectClaudeAgent: async () => "Claude Code connected" });
  expect(step()).not.toBeNull();
  expect(document.body.textContent).not.toContain("Legacy provider backend is unavailable");
  expect(button("Connect").disabled).toBe(false);
});

test("without Claude Code sign-in, Anthropic opens straight on the API-key form as before", async () => {
  await mount({ claudeAgent: undefined, preferredProviderId: "anthropic", authMethods: { anthropic: [{ type: "api", label: "API key", methodIndex: 0 }] } });
  expect(document.body.textContent).not.toContain("Claude Code");
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(button("Save key").disabled).toBe(true);
  expect(step()).toBeNull();
  expect(document.body.textContent).not.toContain("Claude Pro/Max");
});

test("choosing API key under Anthropic still opens the manual key form", async () => {
  await mount({ preferredProviderId: "anthropic" });
  await act(async () => button("API keyPaste a secret key that OpenWork stores locally on this device.").click());
  expect(document.querySelector('input[type="password"]')).not.toBeNull();
  expect(step()).toBeNull();
});

const aiProps: AiSettingsViewProps = {
  busy: false, providerAuthBusy: false, providerStatusLabel: "", providerStatusStyle: "", providerSummary: "",
  providerLoadState: { status: "ready", error: null }, onRetryProviders: () => {}, connectedProviders: [], disconnectingProviderId: null,
  providerConnectError: null, providerDisconnectStatus: null, providerDisconnectError: null, onOpenProviderAuth: () => {},
  onDisconnectProvider: () => {}, canDisconnectProvider: () => true, canAddProviders: true, autoSwitchedOff: true,
};
const settings = (overrides: Partial<AiSettingsViewProps>) => {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(<AiSettingsView {...aiProps} {...overrides} />);
  return container;
};
const claudeRow = (container: HTMLElement) => container.querySelector('[data-testid="local-provider-claude-agent"]');

test("Settings lists Claude Code only once it is connected", () => {
  expect(claudeRow(settings({ claudeAgent: setup }))).toBeNull();
  expect(claudeRow(settings({}))).toBeNull();
  expect(settings({ claudeAgent: setup }).textContent).not.toContain("Claude");
});

test("a connected Claude Code is a normal provider row with its checked state and Disconnect", () => {
  const verified = claudeRow(settings({ claudeAgent: { ...connected(), verified: true } }));
  expect(verified?.textContent).toContain("Claude Code");
  expect(verified?.textContent).toContain("Ready to use");
  expect(verified?.textContent).toContain("Disconnect");
  expect(verified?.textContent).not.toContain("Sign in again");
  // After a restart the engine has not checked `claude` yet: say so rather than "Ready to use".
  const unchecked = claudeRow(settings({ claudeAgent: connected() }));
  expect(unchecked?.textContent).toContain("Not checked yet");
  expect(unchecked?.textContent).not.toContain("Ready to use");
});

test("a Claude Code that got signed out says why and offers to sign in again", () => {
  const problem = claudeRow(settings({ claudeAgent: { ...connected({ status: "needs_auth", message: "Claude Code is not logged in." }), verified: false }, onOpenClaudeAgent: () => {} }));
  expect(problem?.textContent).toContain("Needs your sign-in");
  expect(problem?.textContent).toContain("Claude Code is not logged in.");
  expect([...(problem?.querySelectorAll("button") ?? [])].map((element) => element.textContent)).toEqual(["Sign in again", "Disconnect"]);
  expect(problem?.textContent).not.toContain("Ready to use");
});

test("Claude Code stays reachable when the engine's provider list fails, and nothing changes without it", () => {
  const withClaude = settings({ providerLoadState: { status: "error", error: "Legacy catalog unavailable" }, claudeAgent: setup });
  const connect = [...withClaude.querySelectorAll("button")].find((element) => element.textContent?.includes("Connect a provider"));
  expect(connect?.disabled).toBe(false);
  expect(withClaude.textContent).toContain("Other provider settings could not be loaded.");

  const without = settings({ providerLoadState: { status: "error", error: "Legacy catalog unavailable" } });
  const legacyConnect = [...without.querySelectorAll("button")].find((element) => element.textContent?.includes("Connect a provider"));
  expect(legacyConnect?.disabled).toBe(true);
  expect(without.textContent).toContain("Legacy catalog unavailable");
});
