/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AiSettingsView, type AiSettingsViewProps } from "../src/react-app/domains/settings/pages/ai-view";
import { planOpenWorkModelsRow } from "../src/react-app/domains/settings/pages/openwork-models-row";

const member = { fromOrganization: true, managedByOrganization: false, isOrganizationAdmin: false };

test("an organization that pays for OpenWork Models replaces the free row on this device", () => {
  const plan = planOpenWorkModelsRow({ ...member, disabledProviders: [] });
  expect(plan.showDeviceRow).toBe(false);
  expect(plan.orgRowToggle).toBe(true);
  expect(plan.orgTurnedOff).toBe(false);
  expect(planOpenWorkModelsRow({ ...member, disabledProviders: ["openwork"] }).orgTurnedOff).toBe(true);
});

test("without the organization the free row stays, and neither id is listed twice as turned off", () => {
  const plan = planOpenWorkModelsRow({ ...member, fromOrganization: false, disabledProviders: ["openwork-free"] });
  expect(plan.showDeviceRow).toBe(true);
  expect(plan.orgRowToggle).toBe(false);
  expect([...plan.hideFromDisabledList].sort()).toEqual(["openwork", "openwork-free"]);
});

test("when the organization manages models, only admins can turn OpenWork Models off", () => {
  const managedMember = planOpenWorkModelsRow({ ...member, managedByOrganization: true, disabledProviders: [] });
  expect(managedMember.orgRowToggle).toBe(false);
  expect(managedMember.orgRowManaged).toBe(true);

  const admin = planOpenWorkModelsRow({ ...member, managedByOrganization: true, isOrganizationAdmin: true, disabledProviders: ["openwork"] });
  expect(admin.orgRowToggle).toBe(true);
  expect(admin.orgRowManaged).toBe(false);
  expect(admin.orgTurnedOff).toBe(true);
  expect(admin.clearStaleTurnOff).toBe(false);
});

test("a member's earlier turn-off is undone once the organization manages models", () => {
  const plan = planOpenWorkModelsRow({ ...member, managedByOrganization: true, disabledProviders: ["openwork"] });
  expect(plan.orgTurnedOff).toBe(false);
  expect(plan.clearStaleTurnOff).toBe(true);
  expect(planOpenWorkModelsRow({ ...member, disabledProviders: ["openwork"] }).clearStaleTurnOff).toBe(false);
});

const view: AiSettingsViewProps = {
  busy: false,
  providerAuthBusy: false,
  providerStatusLabel: "",
  providerStatusStyle: "",
  providerSummary: "",
  providerLoadState: { status: "ready", error: null },
  onRetryProviders: () => {},
  connectedProviders: [{ id: "openwork-free", name: "OpenWork Models (Free)", source: "config" }],
  disconnectingProviderId: null,
  providerConnectError: null,
  providerDisconnectStatus: null,
  providerDisconnectError: null,
  onOpenProviderAuth: () => {},
  onDisconnectProvider: () => {},
  canDisconnectProvider: () => true,
  canAddProviders: true,
  autoPreferences: { enabled: true, available: true, canEnable: false },
  onSetAutoEnabled: () => {},
};

test("Settings drops the on-device OpenWork Models row when the organization lists it", () => {
  const withRow = renderToStaticMarkup(<AiSettingsView {...view} />);
  expect(withRow).toContain("settings-auto-provider");
  expect(withRow).toContain("OpenWork Free is unavailable");
  const without = renderToStaticMarkup(<AiSettingsView {...view} showOpenWorkModelsDeviceRow={false} />);
  expect(without).not.toContain("settings-auto-provider");
  expect(without).not.toContain("OpenWork Free is unavailable");
});
