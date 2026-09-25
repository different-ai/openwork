import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createOpenworkServerClient, type ProviderKeyShareEligibility, type ProviderKeyShareInput } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createRoot } = await import("react-dom/client");
const { ProviderKeyShareDialog } = await import("../src/react-app/domains/settings/pages/provider-key-share-dialog");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
afterAll(async () => { if (ownedDom) await GlobalRegistrator.unregister(); });
const eligible: ProviderKeyShareEligibility = { organizationId: "org_fixture", memberId: "mem_fixture", organizationName: "Example Team", eligible: true, reason: null, teams: [{ id: "team_fixture", name: "Engineering" }] };
const receipt = { share: { requestId: "fixture", organizationId: eligible.organizationId, providerId: "anthropic", inferenceProviderId: "ipr_fixture" }, localRemoved: true };
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label);
function props(value = eligible) {
  const sent = mock(async (_input: ProviderKeyShareInput) => receipt);
  return { provider: { id: "anthropic", name: "Anthropic" }, organizationId: value.organizationId, client: { ...createOpenworkServerClient({ baseUrl: "https://device.example.test" }), providerKeyShareEligibility: mock(async () => value), shareProviderKey: sent }, onClose: mock(() => {}), onShared: mock(() => {}), onOpenDen: mock(() => {}) };
}

test("opening verifies eligibility without transferring and consent names destination and removal", async () => {
  const input = props();
  await act(async () => root.render(<ProviderKeyShareDialog {...input} />));
  expect(input.client.providerKeyShareEligibility).toHaveBeenCalledWith("anthropic", "org_fixture");
  expect(input.client.shareProviderKey).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Share Anthropic with Example Team?");
  expect(document.body.textContent).toContain("Moves to Den");
  expect(document.body.textContent).toContain("Leaves this device"); expect(document.body.textContent).toContain("Usage is billed to Example Team");
  await act(async () => button("Share with organization")?.click());
  expect(input.client.shareProviderKey).toHaveBeenCalledWith({ providerId: "anthropic", organizationId: "org_fixture", memberId: "mem_fixture", allMembers: true, teamIds: [], removeLocal: true, confirmed: true });
  expect(input.onShared).toHaveBeenCalledWith(receipt);
});

test("denied eligibility and missing organization do not permit sharing", async () => {
  const input = props({ ...eligible, eligible: false, reason: "Only administrators can share keys." });
  await act(async () => root.render(<ProviderKeyShareDialog {...input} />));
  expect(button("Share with organization")?.disabled).toBe(true);
  expect(document.body.textContent).toContain("Only administrators");
  expect(input.client.shareProviderKey).not.toHaveBeenCalled();
});

test("selected teams require an explicit selection and only those IDs are sent", async () => {
  const input = props();
  await act(async () => root.render(<ProviderKeyShareDialog {...input} />));
  await act(async () => button("Choose teams")?.click());
  expect(button("Share with organization")?.disabled).toBe(true);
  const teamLabel = [...document.querySelectorAll("label")].find((element) => element.textContent === "Engineering");
  const checkbox = teamLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(checkbox).toBeDefined();
  expect(checkbox).not.toBeNull();
  await act(async () => checkbox?.click());
  expect(button("Share with organization")?.disabled).toBe(false);
  await act(async () => button("Share with organization")?.click());
  expect(input.client.shareProviderKey.mock.calls[0][0]).toMatchObject({ allMembers: false, teamIds: ["team_fixture"] });
});
