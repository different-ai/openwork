/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { credentialHealthKey, useProviderCredentialHealth, type ProviderCredentialHealth } from "../src/react-app/domains/connections/provider-auth/credential-health";
import { AiSettingsView, type AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import { LocalProviderStatus } from "../src/react-app/domains/settings/pages/provider-rows";
import { resolveCloudProviderRowStatus, type CloudProviderRowStateInput } from "../src/react-app/domains/settings/pages/cloud-providers-view";

const available: CloudProviderRowStateInput = {
  imported: true,
  outOfSync: false,
  allowed: true,
  importsUnavailable: false,
  needsCredential: false,
  needsServer: false,
  syncError: null,
};

test("local credential status is opt-in and unverified is neutral", () => {
  expect(renderToStaticMarkup(<LocalProviderStatus />)).toContain("Ready to use");
  const unchecked = renderToStaticMarkup(<LocalProviderStatus credentialHealth="unverified" />);
  expect(unchecked).toContain("Not checked yet");
  expect(unchecked).toContain("text-muted-foreground");
  expect(unchecked).not.toContain("Ready to use");
  expect(renderToStaticMarkup(<LocalProviderStatus credentialHealth="verified" />)).toContain("Ready to use");
  const rejected = renderToStaticMarkup(<LocalProviderStatus credentialHealth="rejected" />);
  expect(rejected).toContain("Key not accepted");
  expect(rejected).toContain("text-amber-11");
});

test("engine availability and policy stay above credential health", () => {
  const healthStates: ProviderCredentialHealth[] = ["unverified", "verified", "rejected"];
  for (const credentialHealth of healthStates) {
    const locked = renderToStaticMarkup(<LocalProviderStatus state="managed_by_organization" credentialHealth={credentialHealth} />);
    expect(locked).toContain("Your organization manages AI providers");
    expect(locked).not.toContain("Key not accepted");
    const unavailable = renderToStaticMarkup(<LocalProviderStatus state="not_on_engine" credentialHealth={credentialHealth} />);
    expect(unavailable).toContain("Not available on the new engine yet");
    expect(unavailable).not.toContain("Ready to use");
  }
});

test("organization credential evidence changes status only when supplied", () => {
  expect(resolveCloudProviderRowStatus(available)).toBe("connected");
  expect(resolveCloudProviderRowStatus({ ...available, credentialHealth: "unverified" })).toBe("credential_unverified");
  expect(resolveCloudProviderRowStatus({ ...available, credentialHealth: "verified" })).toBe("connected");
  expect(resolveCloudProviderRowStatus({ ...available, credentialHealth: "rejected" })).toBe("credential_rejected");
});

test("organization access, unavailable engine and pending sync keep their priority", () => {
  const rejected = { ...available, credentialHealth: "rejected" } satisfies CloudProviderRowStateInput;
  expect(resolveCloudProviderRowStatus({ ...rejected, allowed: false })).toBe("blocked");
  expect(resolveCloudProviderRowStatus({ ...rejected, importsUnavailable: true })).toBe("unavailable");
  expect(resolveCloudProviderRowStatus({ ...rejected, needsServer: true })).toBe("needs_server");
  expect(resolveCloudProviderRowStatus({ ...rejected, skippedByServer: true })).toBe("needs_credential");
  expect(resolveCloudProviderRowStatus({ ...rejected, reloadPending: true })).toBe("syncing");
  expect(resolveCloudProviderRowStatus({ ...rejected, imported: false })).toBe("syncing");
});

const localView: AiSettingsViewProps = {
  busy: false,
  runtimeWorkspaceId: "workspace-test",
  providerAuthBusy: false,
  providerStatusLabel: "",
  providerStatusStyle: "",
  providerSummary: "",
  providerLoadState: { status: "ready", error: null },
  onRetryProviders: () => {},
  connectedProviders: [{ id: "provider-test", name: "Test provider", source: "api" }],
  disconnectingProviderId: null,
  providerConnectError: null,
  providerDisconnectStatus: null,
  providerDisconnectError: null,
  onOpenProviderAuth: () => {},
  onReplaceProviderKey: () => {},
  onDisconnectProvider: () => {},
  canDisconnectProvider: () => true,
  canAddProviders: true,
  autoSwitchedOff: true,
};

test("local rejected key recovery is scoped to this runtime workspace", () => {
  const initialState = useProviderCredentialHealth.getInitialState();
  const key = credentialHealthKey("workspace-test", "provider-test");
  const previous = initialState.entries[key];
  // Server rendering reads Zustand's initial snapshot, not its current snapshot.
  initialState.entries[key] = { status: "rejected", revision: 0, observedAt: 0 };
  try {
    const rejected = renderToStaticMarkup(<AiSettingsView {...localView} />);
    expect(rejected).toContain("Key not accepted");
    expect(rejected).toContain("Replace key");
    const otherWorkspace = renderToStaticMarkup(<AiSettingsView {...localView} runtimeWorkspaceId="other-workspace" />);
    expect(otherWorkspace).toContain("Not checked yet");
    expect(otherWorkspace).not.toContain("Replace key");
    const environment = renderToStaticMarkup(<AiSettingsView {...localView} connectedProviders={[{ id: "provider-test", name: "Test provider", source: "env" }]} canDisconnectProvider={() => false} />);
    expect(environment).toContain("Update the environment credential");
    expect(environment).not.toContain("Replace key");
  } finally {
    if (previous) initialState.entries[key] = previous;
    else delete initialState.entries[key];
  }
});

test("organization rejection directs the member to an admin rather than a personal key editor", () => {
  const initialState = useProviderCredentialHealth.getInitialState();
  const key = credentialHealthKey("workspace-test", "ipr_fixture");
  const previous = initialState.entries[key];
  initialState.entries[key] = { status: "rejected", revision: 0, observedAt: 0 };
  try {
    const markup = renderToStaticMarkup(<AiSettingsView {...localView}
      signedIn organizationName="Acme"
      connectedProviders={[{ id: "ipr_fixture", name: "Team provider" }]}
      gatewayProviderIds={new Set(["ipr_fixture"])}
    />);
    expect(markup).toContain("Key not accepted");
    expect(markup).toContain("Contact your admin");
    expect(markup).not.toContain("Replace key");
    expect(markup).not.toContain("Ready to use");
  } finally {
    if (previous) initialState.entries[key] = previous;
    else delete initialState.entries[key];
  }
});
