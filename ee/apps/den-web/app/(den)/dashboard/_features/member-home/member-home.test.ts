import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { getOrgAccessFlags, type DenOrgCapabilities } from "../../../_lib/den-org";
import type { LibraryItem } from "../../_components/library-data";
import { buildDashboardNavSections, buildPersonalPagesSection } from "../../_lib/dashboard-navigation";
import { keyDaysLeft, keyExpiresIn, memberHomeNeeds, memberHomeState } from "./member-home";

const NOW = Date.parse("2026-03-01T12:00:00Z");
const DAY = 86_400_000;

function connection(id: string, state: "connected" | "needs_signin"): LibraryItem {
  return { type: "connection", id, name: id, url: `https://${id}.example.com`, description: null, transport: "mcp", provider: null, state, connectedAt: null, edges: [] };
}

function apiKey(id: string, expiresAt: string | null): GatewayApiKey {
  return { id, name: id, prefix: "owk_test", createdAt: new Date(NOW - DAY).toISOString(), expiresAt, lastUsedAt: null };
}

test("Needs you lists each sign-in and each key about to expire, and nothing else", () => {
  const needs = memberHomeNeeds({
    orgSlug: "acme",
    library: [connection("tracker", "needs_signin"), connection("chat", "connected")],
    providers: [{ id: "p1", name: "Sample Models", iconSlug: "sample", state: "needs_signin" }, { id: "p2", name: "Ready Models", iconSlug: "ready", state: "ready" }],
    apiKeys: [apiKey("soon", new Date(NOW + 3 * DAY).toISOString()), apiKey("later", new Date(NOW + 60 * DAY).toISOString()), apiKey("never", null), apiKey("gone", new Date(NOW - DAY).toISOString())],
    keysEnabled: true,
    now: NOW,
  });
  assert.deepEqual(needs.map((need) => `${need.kind}:${need.id}`), ["connection:tracker", "models:p1", "key:soon"]);
  assert.equal(needs[0]?.kind === "connection" ? needs[0].href : null, "/dashboard/your-connections?connectionId=tracker");
  assert.equal(needs[1]?.kind === "models" ? needs[1].href : null, "/dashboard/library?show=models");
});

test("an expiring key is not a need once the organization turned keys off", () => {
  const needs = memberHomeNeeds({ orgSlug: "acme", library: [], providers: [], apiKeys: [apiKey("soon", new Date(NOW + DAY).toISOString())], keysEnabled: false, now: NOW });
  assert.deepEqual(needs, []);
});

test("key expiry counts whole days and reads plainly", () => {
  assert.equal(keyDaysLeft(null, NOW), null);
  assert.equal(keyDaysLeft(new Date(NOW - 1).toISOString(), NOW), null);
  assert.equal(keyDaysLeft(new Date(NOW + DAY / 2).toISOString(), NOW), 1);
  assert.equal(keyDaysLeft(new Date(NOW + 3 * DAY).toISOString(), NOW), 3);
  assert.equal(keyExpiresIn(1), "expires tomorrow");
  assert.equal(keyExpiresIn(3), "expires in 3 days");
});

test("the line under Home says how much is waiting", () => {
  assert.equal(memberHomeState("Acme", 0), "Acme");
  assert.equal(memberHomeState("Acme", 1), "1 thing needs you");
  assert.equal(memberHomeState("Acme", 2), "2 things need you");
});

const capabilities: DenOrgCapabilities = { auditLogs: false, cloud: false, installLinks: false, mcpConnections: false, openworkWeb: true, workflows: true, workbot: true };

test("a member's sidebar is Home and Workbot; their own pages stay findable by search", () => {
  const sections = buildDashboardNavSections({
    orgSlug: "acme", access: getOrgAccessFlags("member", false, []), capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, libraryNeedsSignIn: 2, organizationId: "org_1",
  });
  const work = sections.find((section) => section.label === "Work");
  assert.deepEqual(work?.items.map((item) => item.label), ["Home", "Workbot"]);
  assert.equal(work?.items[0]?.href, "/dashboard");
  assert.equal(work?.items[0]?.attention, "2 need your sign-in");
  const personal = buildPersonalPagesSection({ orgSlug: "acme", capabilities, runtimeConfigLoaded: true, myBot: true });
  assert.deepEqual(personal.items.map((item) => item.label), ["My bot", "My Library", "My Automations", "My Computers", "My Usage", "OpenWork Web"]);
});

test("an admin's Home carries no sign-in count: the overview already shows it", () => {
  const sections = buildDashboardNavSections({
    orgSlug: "acme", access: getOrgAccessFlags("owner", true, []), capabilities, orgMode: "multi_org", runtimeConfigLoaded: true, libraryNeedsSignIn: 2,
  });
  assert.equal(sections.find((section) => section.label === "Work")?.items[0]?.attention, undefined);
});
