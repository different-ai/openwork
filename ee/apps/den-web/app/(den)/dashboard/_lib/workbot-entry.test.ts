import assert from "node:assert/strict";
import { test } from "node:test";
import { getNewAiGatewayProviderRoute, getOrgAccessFlags, type DenOrgCapabilities } from "../../_lib/den-org";
import { buildDashboardNavSections } from "./dashboard-navigation";
import { decideWorkbotEntry, WORKBOT_ENTRY_COPY, WORKBOT_ENTRY_HREF, type WorkbotEntry } from "./workbot-entry";

const member = getOrgAccessFlags("member", false, []);
const providerManager = getOrgAccessFlags("member", false, ["gateway_providers.view", "gateway_providers.manage"]);
const providerViewer = getOrgAccessFlags("member", false, ["gateway_providers.view"]);
const owner = getOrgAccessFlags("owner", true);
const noProvider = { gatewayRequired: true, hasGatewayProvider: false };

function decide(input: Partial<Parameters<typeof decideWorkbotEntry>[0]> = {}) {
  return decideWorkbotEntry({ readiness: noProvider, access: member, orgSlug: "workspace", ...input });
}

test("Workbot opens as before when it has an AI provider or the Gateway isn't required", () => {
  assert.deepEqual(decide({ readiness: { gatewayRequired: true, hasGatewayProvider: true } }), { kind: "open" });
  assert.deepEqual(decide({ readiness: { gatewayRequired: false, hasGatewayProvider: false } }), { kind: "open" });
});

test("readiness that is loading or failed never blocks Workbot", () => {
  assert.deepEqual(decide({ readiness: undefined }), { kind: "open" });
  assert.deepEqual(decide({ readiness: null, access: owner }), { kind: "open" });
});

test("people who can manage AI Gateway providers are sent to add one", () => {
  for (const access of [providerManager, owner]) {
    assert.deepEqual(decide({ access }), { kind: "add-provider", href: getNewAiGatewayProviderRoute("workspace") });
  }
});

test("everyone else is told an organization admin has to add one", () => {
  assert.deepEqual(decide(), { kind: "ask-admin" });
  // Viewing providers alone is not enough to add one.
  assert.deepEqual(decide({ access: providerViewer }), { kind: "ask-admin" });
  // Without a workspace route there is nowhere to send them.
  assert.deepEqual(decide({ access: owner, orgSlug: null }), { kind: "ask-admin" });
});

const capabilities: DenOrgCapabilities = {
  auditLogs: false, installLinks: false, mcpConnections: false, workflows: true,
  openworkWeb: false, cloud: false, workbot: true,
};

function workbotItem(workbotEntry?: WorkbotEntry) {
  return buildDashboardNavSections({
    orgSlug: "workspace", access: member, capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, workbotEntry,
  }).flatMap((section) => section.items).find((item) => item.href === WORKBOT_ENTRY_HREF);
}

test("a blocked Workbot entry stays in the navigation with a quiet marker (P4)", () => {
  const ready = workbotItem({ kind: "open" });
  assert.ok(ready);
  assert.equal(ready.attention, undefined);
  assert.equal(ready.locked, undefined);
  assert.deepEqual(workbotItem(), ready);

  const admin = workbotItem({ kind: "add-provider", href: getNewAiGatewayProviderRoute("workspace") });
  assert.equal(admin?.href, WORKBOT_ENTRY_HREF);
  assert.equal(admin?.attention, WORKBOT_ENTRY_COPY.addProviderTitle);
  assert.equal(admin?.locked, undefined);

  const others = workbotItem({ kind: "ask-admin" });
  assert.equal(others?.href, WORKBOT_ENTRY_HREF);
  assert.equal(others?.locked, WORKBOT_ENTRY_COPY.askAdminTitle);
  assert.equal(others?.attention, undefined);
});
