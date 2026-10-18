import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { automationsInventory } from "../worlds/automations-inventory.ts";

const test = spec.world(automationsInventory, { timeout: 300_000, resources: { surfaces: ["appWeb"], services: ["den"] } });

test("a member keeps a cached calendar through a partial refresh but cannot see denied automations", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("the member loads and searches beyond the first hundred Automations", async () => {
    await user.click({ role: "button", label: /^Automations$/ });
    await user.see({ text: "100 loaded; more Automations available" });
    await user.click({ role: "button", label: "Load more Automations" });
    await user.see({ text: "120 loaded; all Automations loaded" });
    await user.type({ placeholder: "Search loaded Automations" }, "Inventory brief 119");
    await user.see({ role: "heading", label: "Inventory brief 119" });
    expect((await probe.dom("[data-automation-id]")).elements).toHaveLength(1);
    const reads = await world.requests();
    const requested = reads.some(row => row.path.includes("cursor=page_100") && row.status === 200);
    const preflight = reads.some(row => row.method === "OPTIONS" && row.path.includes("/automations") && row.status === 204);
    expect(requested && preflight).toBe(true);
    evidence.recordAssertionEvidence("The real Automations page passes preflight and follows its cursor", "Production preflight accepted; 120 loaded; Inventory brief 119 found; one row mounted", requested && preflight);
    await user.screenshot();
    await user.type({ placeholder: "Search loaded Automations" }, "", { replace: true });
  });
  await step("after: Calendar keeps its overview and meetings when a shared second-page refresh fails", async () => {
    await world.unavailable();
    const before = (await world.requests()).length;
    // A sidebar transition keeps the actual application/query cache; a navigation reload would not exercise this bug.
    await user.click({ role: "button", label: /^Calendar$/ });
    await user.see({ text: "Couldn't refresh all Automations. Showing the last verified overview." });
    await user.see({ role: "button", label: /Inventory brief 000/ });
    await user.see({ role: "button", label: /Inventory team review/ });
    expect((await probe.dom("[data-calendar-grid]")).elements.length).toBeGreaterThan(0);
    const reads = (await world.requests()).slice(before);
    const witnessed = reads.some(row => row.path.includes("/automations?limit=100") && !row.path.includes("cursor=") && row.status === 200) && reads.some(row => row.path.includes("cursor=page_100") && row.status === 503);
    expect(witnessed).toBe(true);
    evidence.recordAssertionEvidence("A failed continuation cannot replace the production Calendar", "First page 200; second page 503; automation block and team meeting stay visible with inline Retry", witnessed);
    await user.screenshot();
  });
  await step("a denied continuation masks cached names and instructions even though the session remains signed in", async () => {
    await world.deny();
    await user.click({ role: "button", label: /^Automations$/ });
    await user.see({ role: "heading", label: "Automation access is blocked" });
    await user.notSee({ text: /Inventory brief/ });
    await user.notSee({ text: /Summarize project note/ });
    expect((await probe.dom("[data-automation-id]")).elements).toHaveLength(0);
    const denied = (await world.requests()).some(row => row.path.includes("cursor=page_100") && row.status === 403);
    expect(denied).toBe(true);
    evidence.recordAssertionEvidence("An authoritative denial masks the real page's cached content", "Second-page 403; no automation cards, names or instructions rendered", denied);
    await user.screenshot();
  });
  await step("a later network failure cannot clear the authorization barrier", async () => {
    await world.unavailable();
    const before = (await world.requests()).length;
    await user.click({ role: "button", label: /^Calendar$/ });
    await probe.eventually(() => world.requests(), { within: 15000, label: "Calendar's shared denied inventory reaches the unavailable continuation", until: rows => rows.slice(before).some(row => row.path.includes("cursor=page_100") && row.status === 503) });
    await probe.eventually(() => probe.dom('button:not(:disabled)'), { within: 15000, label: "the unavailable retry finishes without revealing cached content", until: value => value.elements.some(element => element.text === "Retry") });
    await user.see({ role: "heading", label: "Calendar access is blocked" });
    await user.notSee({ text: /Inventory brief/ });
    await user.notSee({ text: /Summarize project note/ });
    await user.notSee({ role: "button", label: /Inventory team review/ });
    evidence.recordAssertionEvidence("403 followed by 503 remains denied across the real pages", "Calendar's shared refresh receives 503 after the denial; cached automations, meetings and instructions remain absent", (await probe.dom("[data-calendar-grid]")).elements.length === 0);
    await user.screenshot();
  });
  await step("only a fresh authorized read restores the inventory", async () => {
    const before = (await world.requests()).length;
    await world.authorize();
    await user.click({ role: "button", label: "Retry" });
    await user.see({ role: "button", label: /Inventory brief 000/ });
    await user.see({ role: "button", label: /Inventory team review/ });
    await user.click({ role: "button", label: /^Automations$/ });
    await user.see({ text: "120 loaded; all Automations loaded" });
    await user.see({ role: "heading", label: "Inventory brief 000" });
    await user.notSee({ role: "heading", label: "Automation access is blocked" });
    expect((await probe.dom("[data-automation-id]")).elements).toHaveLength(20);
    const freshMeeting = (await world.requests()).slice(before).some(row => row.path.includes("google-workspace/calendar-events") && row.status === 200);
    expect(freshMeeting).toBe(true);
    evidence.recordAssertionEvidence("Authorized recovery requires fresh inventory and meeting reads", "Fresh inventory and meeting reads return 200; 120 loaded, 20 mounted cards", freshMeeting && (await probe.dom("[data-automation-id]")).elements.length === 20);
    await user.screenshot();
  });
});
