/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceShareOptions } from "@openwork/types/den/device-provider-share";
import { OrganizationShareEmpty } from "../src/react-app/domains/settings/cloud/sections";
import { AiSettingsView, type AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import {
  deviceProviderShareRows,
  deviceShareCandidates,
  organizationShareEmptyState,
  shareConsentFacts,
  shareFailureMessage,
  shareNeedsReview,
  shareLockedLine,
  shareNeedsVerification,
  type ShareableDeviceProvider,
} from "../src/react-app/domains/settings/provider-share/device-provider-share";

const anthropic: ShareableDeviceProvider = { id: "anthropic", name: "Anthropic", source: "api" };
const openai: ShareableDeviceProvider = { id: "openai", name: "OpenAI", source: "api" };
const groq: ShareableDeviceProvider = { id: "groq", name: "Groq", source: "api" };

const owner = (providers: DeviceShareOptions["providers"]): DeviceShareOptions =>
  ({ canShare: true, blocker: null, managerName: null, verificationRequired: false, providers });
const member: DeviceShareOptions = { canShare: false, blocker: "no_permission", managerName: "Avery Owner", verificationRequired: false, providers: [] };

test("only an API key this person pasted, and the provider accepts, is worth asking about", () => {
  const providers: ShareableDeviceProvider[] = [
    anthropic,
    { id: "openai", name: "OpenAI (ChatGPT sign-in)", source: "custom" },
    { id: "google", name: "Google", source: "env" },
    { id: "local-gateway", name: "Hand-written", source: "config" },
    { id: "engine-only", name: "Listed by the engine" },
    { id: "ipr_01abc", name: "Team OpenAI", source: "api" },
    { id: "openwork", name: "OpenWork Models", source: "api" },
    { id: "mistral", name: "Mistral", source: "api" },
  ];
  const candidates = deviceShareCandidates(providers, (id) => id === "mistral" ? "rejected" : "unverified");
  expect(candidates.map((provider) => provider.id)).toEqual(["anthropic"]);
});

test("a row is shareable or already shared only when Den says this person may share", () => {
  const candidates = [anthropic, openai, groq];
  const rows = deviceProviderShareRows(owner([
    { providerId: "anthropic", name: "Anthropic", status: "shareable" },
    { providerId: "openai", name: "OpenAI", status: "shared", sharedAs: "Team OpenAI" },
    { providerId: "groq", name: "Groq", status: "unsupported" },
    // Den answering about a provider that is not a key on this device changes nothing.
    { providerId: "mistral", name: "Mistral", status: "shareable" },
  ]), candidates);
  expect([...rows]).toEqual([["anthropic", { state: "shareable" }], ["openai", { state: "shared", sharedAs: "Team OpenAI" }]]);
  expect(deviceProviderShareRows(member, candidates).size).toBe(0);
  expect(deviceProviderShareRows(null, candidates).size).toBe(0);
});

test("an organization with nothing shared offers the next step, or who manages it", () => {
  const shareable = owner([
    { providerId: "anthropic", name: "Anthropic", status: "unsupported" },
    { providerId: "openai", name: "OpenAI", status: "shareable" },
  ]);
  expect(organizationShareEmptyState(shareable, [anthropic, openai])).toEqual({ kind: "share", provider: { id: "openai", name: "OpenAI" } });
  expect(organizationShareEmptyState(owner([]), [])).toEqual({ kind: "add" });
  expect(organizationShareEmptyState(member, [anthropic])).toEqual({ kind: "locked", managerName: "Avery Owner" });
  // No AI Gateway on this deployment, the feature off, or Den not answered: the plain empty line stays.
  expect(organizationShareEmptyState({ ...member, blocker: "gateway_unavailable", managerName: null }, [anthropic])).toBeNull();
  expect(organizationShareEmptyState(null, [anthropic])).toBeNull();
  expect(shareLockedLine("Avery Owner", "Acme")).toBe("Avery Owner manages AI providers for Acme.");
  expect(shareLockedLine(null, "Acme")).toBe("Your workspace owner manages AI providers for Acme.");
});

test("the confirmation names who can use the key, where it goes, who pays and how to undo it", () => {
  const facts = shareConsentFacts({ providerName: "Anthropic", organizationName: "Acme" });
  expect(facts.map((fact) => fact.label)).toEqual(["Who can use it", "Your key", "Cost", "Changing it"]);
  expect(facts[0]?.value).toContain("Everyone in Acme, including people you invite later");
  expect(facts[1]?.value).toContain("Leaves this device");
  expect(facts[2]?.value).toContain("billed to your Anthropic account");
});

test("a refused share reads as what happened, and verification is not a failure", () => {
  expect(shareNeedsVerification({ code: "verification_required" })).toBe(true);
  expect(shareNeedsVerification({ code: "forbidden" })).toBe(false);
  expect(shareNeedsVerification(new Error("verification_required"))).toBe(false);
  expect(shareFailureMessage({ code: "already_shared" })).toBe("Your organization already has this provider.");
  expect(shareFailureMessage({ code: "forbidden" })).toBe("Only people who manage AI Gateway can share a provider.");
  expect(shareFailureMessage(new Error("socket hang up sk-secret"))).toBe("Could not confirm this share. Check AI Providers before trying again.");
  expect(shareNeedsReview(new Error("lost response"))).toBe(true);
  expect(shareNeedsReview({ code: "share_unconfirmed" })).toBe(true);
  expect(shareNeedsReview({ code: "forbidden" })).toBe(false);
});

const view: AiSettingsViewProps = {
  busy: false,
  runtimeWorkspaceId: "workspace-test",
  providerAuthBusy: false,
  providerStatusLabel: "",
  providerStatusStyle: "",
  providerSummary: "",
  providerLoadState: { status: "ready", error: null },
  onRetryProviders: () => {},
  connectedProviders: [anthropic, openai],
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
  signedIn: true,
  organizationName: "Acme",
  cloudProvidersView: null,
};

test("with nothing to share, AI Providers reads exactly as before", () => {
  const markup = renderToStaticMarkup(<AiSettingsView {...view} />);
  expect(markup).not.toContain("Share with");
  expect(markup).not.toContain("Shared with");
  expect(markup).toContain("Keys never leave this device and only you can disconnect them.");
  expect(renderToStaticMarkup(<AiSettingsView {...view} shareRows={new Map()} onShareProvider={() => {}} />)).toBe(markup);
});

test("a shareable key gets one action naming the organization, and a shared one says so", () => {
  const markup = renderToStaticMarkup(<AiSettingsView
    {...view}
    shareRows={new Map([["anthropic", { state: "shareable" }], ["openai", { state: "shared", sharedAs: "OpenAI" }]])}
    onShareProvider={() => {}}
  />);
  expect(markup).toContain('data-testid="share-provider-anthropic"');
  expect(markup).toContain("Share with Acme");
  expect(markup).not.toContain('data-testid="share-provider-openai"');
  expect(markup).toContain("API key · also available from Acme");
  // The section no longer promises what a share changes.
  expect(markup).not.toContain("Keys never leave this device");
  expect(markup).toContain("A key stays on this device unless you share it");
  // Both keys can still be disconnected from this device.
  expect(markup.match(/>Disconnect</g)?.length).toBe(2);
});

test("the empty organization section gives direction to an owner and a locked line to a member", () => {
  const share = renderToStaticMarkup(<OrganizationShareEmpty state={{ kind: "share", provider: { id: "anthropic", name: "Anthropic" } }} organizationName="Acme" onShareProvider={() => {}} />);
  expect(share).toContain("No organization models are available here yet. People you invite can&#x27;t use the keys on this device.");
  expect(share).toContain("Share Anthropic with Acme");
  const add = renderToStaticMarkup(<OrganizationShareEmpty state={{ kind: "add" }} organizationName="Acme" onOpenDen={() => {}} />);
  expect(add).toContain("Add or grant access to a provider in AI Gateway.");
  expect(add).toContain("Add a provider<");
  const locked = renderToStaticMarkup(<OrganizationShareEmpty state={{ kind: "locked", managerName: "Avery Owner" }} organizationName="Acme" onShareProvider={() => {}} onOpenDen={() => {}} />);
  expect(locked).toContain('data-state="locked"');
  expect(locked).toContain("Avery Owner manages AI providers for Acme. Nothing is shared with you yet.");
  expect(locked).not.toContain("<button");
  // Blocked is neutral ink, never red.
  expect(locked).toContain("text-muted-foreground");
  expect(locked).not.toMatch(/text-red|destructive/);
});
