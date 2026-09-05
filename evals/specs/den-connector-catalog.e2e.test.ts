import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectorCatalogManagement, isRecord, records } from "../worlds/library.ts";

const test = spec.world(connectorCatalogManagement, { timeout: 600_000 });

test("Den catalog shows its full inventory, preserves service identity, and keeps account readiness personal", async ({ world, user, probe, step }) => {
  const admin = user.on(world.web);
  const member = user.on(world.memberWeb);
  const catalog = probe.on(world.web);
  const catalogUrl = `${world.den.ref.webUrl}/dashboard/mcp-connections`;
  const presetResponse = await probe.api(world.den.admin, "/v1/mcp-connections/presets");
  expect(presetResponse.response.ok).toBe(true);
  if (!isRecord(presetResponse.body)) throw new Error("Den returned no preset inventory.");
  const presets = records(presetResponse.body.presets);
  const presetIds = presets.map((entry) => entry.presetId);
  expect(presetIds).toEqual(expect.arrayContaining(["github", "notion", "slack", "context7", "exa"]));
  expect(new Set(presetIds).size).toBe(presetIds.length);
  const popularIds = ["gmail", "github", "google-drive", "google-calendar", "notion", "slack"];
  const expectedIds = [...popularIds, "microsoft-365", ...presetIds.filter((id) => !popularIds.includes(String(id)))];
  const before = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
  expect(before.response.ok).toBe(true);
  const requestsBefore = (await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token");

  await step("browse every integration with an accurate total and setup requirements", async () => {
    await admin.see({ testId: "connector-catalog-count" }, { text: `Showing 6 of ${expectedIds.length} integrations`, timeoutMs: 90_000 });
    await admin.see({ role: "button", label: "Set up Slack" });
    await admin.see({ role: "button", label: "Connect Notion" });
    await admin.click({ testId: "connector-catalog-more" });
    const facts = await catalog.connectorCatalog();
    expect(facts.entries.map((entry) => entry.id)).toEqual(expectedIds);
    expect(facts.summary).toBe(`Showing ${expectedIds.length} of ${expectedIds.length} integrations`);
    expect(facts.horizontalOverflow).toBe(false);
    expect(facts.entries.find((entry) => entry.id === "slack")?.status).toBe("OAuth app required");
    expect(facts.entries.find((entry) => entry.id === "exa")?.status).toBe("API key");
    expect(facts.entries.find((entry) => entry.id === "context7")?.status).toBe("Instant — no sign-in");
    for (const entry of facts.entries) {
      expect(entry.text.trim().length).toBeGreaterThan(entry.id.length);
      expect(entry.href).toContain(`/mcp-connections/${entry.id}`);
      expect(entry.status.length).toBeGreaterThan(0);
    }
    await admin.screenshot();
  });

  await step("filter the full inventory and recover from an empty result", async () => {
    await admin.type({ testId: "connector-smart-bar" }, "granola", { replace: true });
    await admin.see({ testId: "connector-catalog-count" }, { text: `1 of ${expectedIds.length} integrations match` });
    expect((await catalog.connectorCatalog()).entries.map((entry) => entry.id)).toEqual(["granola"]);
    await admin.type({ testId: "connector-smart-bar" }, "catalog-no-match", { replace: true });
    await admin.see({ testId: "connector-catalog-count" }, { text: `0 of ${expectedIds.length} integrations match` });
    expect((await catalog.connectorCatalog()).entries).toEqual([]);
    await admin.type({ testId: "connector-smart-bar" }, "gmail", { replace: true });
    await admin.click({ testId: "connector-open-gmail" });
    await admin.see({ testId: "connector-detail-title" }, { text: /^Gmail\b/ });
    await admin.see({ testId: "connector-detail-state" }, { text: "Needs your account" });
    await admin.reload();
    await admin.see({ testId: "connector-detail-title" }, { text: /^Gmail\b/ });
    await admin.see({ text: "Google Workspace — one connection covers Gmail, Drive, and Calendar" });
    await admin.screenshot();
    for (const [id, label] of [["google-drive", "Google Drive"], ["google-calendar", "Google Calendar"]]) {
      await admin.navigate(catalogUrl);
      await admin.click({ testId: `connector-open-${id}` });
      await admin.see({ testId: "connector-detail-title" }, { text: new RegExp(`^${label}\\b`) });
    }
    const after = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    expect(after.body).toEqual(before.body);
    expect((await world.connector.requests()).filter((entry) => entry.path === "/authorize" || entry.path === "/token")).toEqual(requestsBefore);
    expect(await probe.toolCalls(world.connector)).toEqual([]);
  });

  await step("a member connects without making the admin personally connected", async () => {
    await member.see({ text: "Catalog Notes" }, { timeoutMs: 90_000 });
    await member.click({ testId: `connect-my-mcp-account-${world.connection.id}` });
    await member.see({ testId: `disconnect-my-mcp-account-${world.connection.id}` }, { timeoutMs: 120_000 });
    const memberState = await probe.api(world.den.members.member, "/v1/mcp-connections?scope=usable");
    if (!isRecord(memberState.body)) throw new Error("Den returned no member connections.");
    expect(records(memberState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: true });
    await admin.navigate(`${catalogUrl}/${world.connection.id}`);
    await admin.see({ testId: "connector-detail-state" }, { text: "Needs your account" });
    await admin.notSee({ testId: "connector-detail-test-tools" });
    const adminState = await probe.api(world.den.admin, "/v1/mcp-connections?scope=manageable");
    if (!isRecord(adminState.body)) throw new Error("Den returned no admin connections.");
    expect(records(adminState.body.connections).find((entry) => entry.id === world.connection.id)).toMatchObject({ connectedForMe: false, connected: true });
    await admin.screenshot();
  });
});
