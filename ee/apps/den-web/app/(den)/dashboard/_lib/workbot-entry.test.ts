import assert from "node:assert/strict";
import { test } from "node:test";
import { getNewAiGatewayProviderRoute, getOrgAccessFlags, type DenOrgCapabilities } from "../../_lib/den-org";
import { buildDashboardNavSections } from "./dashboard-navigation";
import { decideWorkbotEntry, isWorkbotEntryHref, WORKBOT_ENTRY_COPY, WORKBOT_ENTRY_HREF, workbotDestination, workbotEntryHref, type WorkbotEntry } from "./workbot-entry";

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

test("the Workbot entry names the workspace on screen, and Den passes only a well-formed id on to Workbot", () => {
  const entry = buildDashboardNavSections({ orgSlug: "test-org", organizationId: "org_test", access: member, capabilities, orgMode: "multi_org", runtimeConfigLoaded: true })
    .flatMap((section) => section.items).find((item) => item.testId === "dashboard-nav-workbot");
  assert.equal(entry?.href, "/workbot?organizationId=org_test");
  assert.equal(isWorkbotEntryHref(entry?.href ?? ""), true);
  assert.equal(workbotEntryHref(null), WORKBOT_ENTRY_HREF);
  assert.equal(isWorkbotEntryHref("/workbotx"), false);

  assert.equal(workbotDestination("https://chat.example.test", "org_test"), "https://chat.example.test/?organization=org_test");
  for (const bad of [undefined, "", "org test", ["org_a", "org_b"], "x".repeat(200)]) {
    assert.equal(workbotDestination("https://chat.example.test", bad), "https://chat.example.test");
  }
});
