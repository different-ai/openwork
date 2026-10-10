import { expect } from "vitest";
import { spec, type Probe, type Target } from "@openwork/testkit";
import { aiGatewaySpendLimits } from "../worlds/ai-gateway-spend-limits.ts";

const test = spec.world(aiGatewaySpendLimits, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

const teamPicker = { role: "combobox", label: "Team" } satisfies Target;
const teamInputSelector = 'input[role="combobox"][aria-label="Team"]';
// The same semantic parent exists before and after the repair, so a control
// run reaches the geometry/hit-test witness instead of failing on a new marker.
const popupSelector = 'div:has(> [role="listbox"])';

async function teamPopupGeometry(probe: Probe, viewport: { width: number; height: number }) {
  let previous = "";
  const snapshot = await probe.eventually(() => probe.dom(popupSelector), {
    within: 10_000, label: "the open team list has settled geometry",
    until: (value) => {
      const current = JSON.stringify(value);
      const settled = current === previous;
      previous = current;
      const rect = value.elements[0]?.rect;
      return settled && value.elements.length === 1 && Boolean(rect && rect.width > 0 && rect.left >= 7 && rect.top >= 7);
    },
  });
  const popup = snapshot.elements[0]?.rect;
  if (!popup) throw new Error("The team list is missing");
  expect(snapshot.documentWidth).toBeLessThanOrEqual(snapshot.viewportWidth);
  expect(popup.left).toBeGreaterThanOrEqual(7);
  expect(popup.right).toBeLessThanOrEqual(viewport.width - 7);
  expect(popup.top).toBeGreaterThanOrEqual(7);
  expect(popup.bottom).toBeLessThanOrEqual(viewport.height - 7);
  return { ...snapshot, popup };
}

async function expectTeamInputFocused(probe: Probe) {
  const input = await probe.eventually(() => probe.dom(teamInputSelector), {
    within: 5_000, label: "Team retains input focus", until: (value) => value.elements[0]?.focused === true,
  });
  expect(input.elements[0]?.focused).toBe(true);
}

type Policy = { id: string; name: string; revision: number; archivedAt?: string | null; limits: { timeframe: string; costLimitMicroUsd: number }[]; assignments: { id: string; teamId: string | null; memberId: string | null; organization: boolean }[] };

function policies(body: unknown): Policy[] {
  const list = body && typeof body === "object" && "policies" in body ? body.policies : [];
  return Array.isArray(list) ? list.filter((entry): entry is Policy => typeof entry === "object" && entry !== null && "id" in entry) : [];
}

test("an owner gives the Design team $20 a day and $300 a month each, deletes it, and brings it back with Undo", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const finalTeam = world.pickerTeams[world.pickerTeams.length - 1];
  if (!finalTeam) throw new Error("The team-picker proof needs a long catalog");
  const policiesPath = "/v1/gateway/usage-limit-policies";
  const limitsUrl = `${world.den.ref.webUrl}/dashboard/ai-gateway?tab=limits`;
  const design = async () => policies((await probe.api(world.den.admin, policiesPath)).body).find((entry) => entry.assignments.some((assignment) => assignment.teamId === world.teamId));

  await step("before: Limits has no spend limits and offers one way to add one", async () => {
    await owner.navigate(limitsUrl);
    await owner.see({ testId: "gateway-limits-empty" }, { timeoutMs: 90_000 });
    await owner.see({ text: "No spend limits yet" });
    const before = policies((await probe.api(world.den.admin, policiesPath)).body);
    evidence.recordAssertionEvidence("no limits yet", `GET ${policiesPath} → ${before.length} policies`, before.length === 0);
    expect(before).toHaveLength(0);
    await owner.screenshot();
  });

  await step("the owner opens all thirteen teams, including names too long for the chooser", async () => {
    await owner.click({ testId: "gateway-limit-new" });
    await owner.see({ testId: "gateway-limit-editor" }, { timeoutMs: 30_000 });
    await owner.click({ role: "switch", label: "Everyone in the organization" });
    await owner.click({ testId: "gateway-limit-add-team" });
    await owner.click(teamPicker);
    const snapshot = await teamPopupGeometry(page, { width: 1440, height: 1100 });
    const options = (await page.dom('[role="option"]')).elements;
    expect(options).toHaveLength(world.pickerTeams.length);
    expect(options.length).toBeGreaterThan(8);
    expect(options.some((option) => option.text.startsWith(finalTeam.name))).toBe(true);
    await expectTeamInputFocused(page);
    const card = (await page.dom('[data-testid="gateway-limit-editor"] section:first-of-type')).elements[0]?.rect;
    if (!card) throw new Error("The actual Who card is missing");
    expect(snapshot.popup.bottom).toBeGreaterThan(card.bottom);
    evidence.recordAssertionEvidence("the complete team list extends beyond its settings card", `${options.length} real teams; Who card bottom ${card.bottom.toFixed(1)}px; open list bottom ${snapshot.popup.bottom.toFixed(1)}px; Team input retains focus`, true);
    await owner.screenshot();
  });

  await step("Escape closes the team list and returns to its input without assigning a team", async () => {
    await owner.press("Escape");
    await owner.notSee({ role: "listbox" });
    await expectTeamInputFocused(page);
    await owner.notSee({ testId: "gateway-limit-who-row" });
    expect(policies((await probe.api(world.den.admin, policiesPath)).body)).toHaveLength(0);
    evidence.recordAssertionEvidence("Escape dismisses the chooser rather than saving a selection", "Team input is focused; no team is selected and Den still has zero spend-limit policies", true);
    await owner.screenshot();
  });

  for (const viewport of [{ width: 667, height: 375, deviceScaleFactor: 1 }, { width: 390, height: 568, deviceScaleFactor: 1 }]) {
    await step(`after: at ${viewport.width} × ${viewport.height}, the owner can reach the last long team without clipping`, async () => {
      await owner.resizeViewport(viewport);
      await owner.click(teamPicker);
      await owner.press("End");
      const snapshot = await teamPopupGeometry(page, viewport);
      const trigger = (await page.dom(teamInputSelector)).elements[0]?.rect;
      if (!trigger) throw new Error("The real Team input is missing");
      const options = (await page.dom('[role="option"]')).elements;
      expect(options).toHaveLength(world.pickerTeams.length);
      const naturalHeight = Math.min(288, options.reduce((height, option) => height + option.rect.height, 12)) + 2;
      // A full preferred-down menu cannot fit here. Old inline geometry fails
      // the viewport assertion above; counting options would not catch that.
      expect(trigger.bottom + 6 + naturalHeight).toBeGreaterThan(viewport.height - 8);
      const lastOption = await page.eventually(async () => (await page.dom('[role="option"]')).elements.find((option) => option.text.startsWith(finalTeam.name)), {
        within: 5_000, label: "End reveals the last team inside the bounded list",
        until: (option) => Boolean(option && option.rect.top >= snapshot.popup.top && option.rect.bottom <= snapshot.popup.bottom),
      });
      if (!lastOption) throw new Error("The last long team is missing");
      expect(lastOption.rect.top).toBeGreaterThanOrEqual(snapshot.popup.top);
      expect(lastOption.rect.bottom).toBeLessThanOrEqual(snapshot.popup.bottom);
      await expectTeamInputFocused(page);
      await owner.screenshot();
      await owner.click({ role: "option", label: new RegExp(finalTeam.name) });
      await owner.notSee({ role: "listbox" });
      await owner.see({ testId: "gateway-limit-who-row" }, { text: new RegExp(finalTeam.name) });
      expect(policies((await probe.api(world.den.admin, policiesPath)).body)).toHaveLength(0);
      evidence.recordAssertionEvidence("the viewport collision is real and the last team accepts trusted input", `${viewport.width}×${viewport.height}: preferred-down menu would end at ${(trigger.bottom + 6 + naturalHeight).toFixed(1)}px, past the viewport; actual list [${snapshot.popup.left.toFixed(1)}, ${snapshot.popup.top.toFixed(1)}]–[${snapshot.popup.right.toFixed(1)}, ${snapshot.popup.bottom.toFixed(1)}]; End reveals the final long label and its trusted click assigns only the draft`, true);
      // This existing journey gives Design the limit, not the stress fixture.
      // Remove the temporary selection through the UI before the next beat.
      await owner.resizeViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });
      await owner.click({ role: "button", label: "Remove" });
      await owner.notSee({ testId: "gateway-limit-who-row" });
      await owner.click({ testId: "gateway-limit-add-team" });
    });
  }

  await step("filtering the portaled team list keeps input focus when nothing matches", async () => {
    await owner.click(teamPicker);
    await owner.type(teamPicker, "no-team-matches", { replace: true });
    await owner.see({ text: 'No teams to add "no-team-matches"' });
    expect((await page.dom('[role="option"]')).elements).toHaveLength(0);
    expect((await page.dom(popupSelector)).elements).toHaveLength(1);
    await expectTeamInputFocused(page);
    evidence.recordAssertionEvidence("search is inside the same open chooser", "The list remains open with its no-results state, zero matching teams, and Team input still focused", true);
    await owner.screenshot();
  });

  await step("the owner filters to Design, clicks that team, and sets daily and monthly amounts", async () => {
    await owner.type(teamPicker, "Design", { replace: true });
    await owner.see({ role: "option", label: /^Design/ });
    expect((await page.dom('[role="option"]')).elements).toHaveLength(1);
    await teamPopupGeometry(page, { width: 1440, height: 1100 });
    await owner.screenshot();
    await owner.click({ role: "option", label: /^Design/ });
    await owner.notSee({ role: "listbox" });
    await owner.see({ testId: "gateway-limit-who-row" }, { text: /Design/ });
    expect((await page.dom('[data-testid="gateway-limit-who-row"]')).elements).toHaveLength(1);
    await owner.click({ role: "switch", label: "Limit per day" });
    await owner.type({ testId: "gateway-limit-amount-day" }, "20");
    await owner.type({ testId: "gateway-limit-amount-month" }, "300");
    await owner.see({ testId: "gateway-limit-period-day" }, { text: /Resets every day/ });
    await owner.see({ testId: "gateway-limit-period-month" }, { text: /Resets on the 1st/ });
    expect(policies((await probe.api(world.den.admin, policiesPath)).body)).toHaveLength(0);
    evidence.recordAssertionEvidence("filtering and trusted selection preserve the spend-limit draft", "Design is the only selected team; $20 daily and $300 monthly are entered; Den still has zero policies until Save", true);
    await owner.screenshot();
  });

  await step("after: Limits shows one Design row with both amounts, applied to each person", async () => {
    await owner.click({ testId: "gateway-limit-save" });
    await owner.see({ testId: "gateway-limit-row" }, { text: /\$20\.00 a day, \$300\.00 a month each/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-limit-row" }, { text: /Pauses them/ });
    const saved = await design();
    const limits = Object.fromEntries((saved?.limits ?? []).map((limit) => [limit.timeframe, limit.costLimitMicroUsd]));
    expect(saved?.assignments).toEqual([{ id: expect.any(String), teamId: world.teamId, memberId: null, organization: false }]);
    expect(saved?.assignments.some((assignment) => assignment.teamId === finalTeam.id)).toBe(false);
    evidence.recordAssertionEvidence("saved as one policy assigned only to Design", `name "${saved?.name}"; day ${limits.day}; month ${limits.month}; one persisted Design team assignment; the temporarily chosen long-label team has no assignment`, limits.day === 20_000_000 && limits.month === 300_000_000 && saved?.assignments.length === 1 && saved.assignments[0]?.teamId === world.teamId);
    expect(limits).toEqual({ day: 20_000_000, month: 300_000_000 });
    await owner.screenshot();
  });

  await step("Users & Teams: Teams, then Design, lists its people under Design's limit", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway?tab=users-and-teams`);
    await owner.see({ testId: "gateway-directory-everyone" }, { timeoutMs: 60_000 });
    await owner.click({ role: "radio", label: /Teams/ });
    await owner.see({ testId: "gateway-directory-team-row", label: /^Design/ }, { text: /Design[\s\S]*\$20\.00 a day, \$300\.00 a month each[\s\S]*Team limit/, timeoutMs: 30_000 });
    await owner.screenshot();
    await owner.click({ testId: "gateway-directory-team-row", label: /^Design/ });
    await owner.see({ testId: "gateway-directory-team-strip" }, { text: /Design[\s\S]*\$20\.00 a day, \$300\.00 a month each/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-directory-team-limit" }, { text: "Edit team limit" });
    const rows = await probe.on(world.web).dom('[data-testid="gateway-directory-person-row"]');
    evidence.recordAssertionEvidence("Design filter shows only its people with the team limit", `rows ${rows.elements.length}: ${rows.elements.map((row) => row.text).join(" | ")}`, rows.elements.length === 1 && rows.elements[0]?.text.includes("From Design") === true);
    expect(rows.elements).toHaveLength(1);
    expect(rows.elements[0]?.text).toContain("From Design");
    await owner.screenshot();
  });

  await step("the teammate's page shows both periods of Design's limit", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/people/${encodeURIComponent(world.teammateId)}`);
    await owner.see({ testId: "gateway-person-limit" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "gateway-person-limit" }, { text: /\$20\.00 a day[\s\S]*\$300\.00 a month/ });
    const rows = await probe.on(world.web).dom('[data-testid="gateway-person-limit-row"]');
    expect(rows.elements.map((row) => /^\$[\d.,]+ a (?:day|week|month)/.exec(row.text)?.[0])).toEqual(["$20.00 a day", "$300.00 a month"]);
    evidence.recordAssertionEvidence("teammate inherits the team limit", `Spend limit rows: ${rows.elements.map((row) => /^\$[\d.,]+ a (?:day|week|month)/.exec(row.text)?.[0]).join(", ")}`, rows.elements.length === 2);
    await owner.screenshot();
  });

  await step("the owner deletes Design's limit from its page without a confirm", async () => {
    await owner.navigate(limitsUrl);
    await owner.see({ testId: "gateway-limit-row" }, { text: /Design/, timeoutMs: 60_000 });
    await owner.click({ testId: "gateway-limit-edit" });
    await owner.see({ testId: "gateway-limit-delete" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-limit-delete" });
    await owner.see({ testId: "gateway-limit-deleted" }, { text: /Deleted Design/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-limits-empty" });
    const deleted = await design();
    evidence.recordAssertionEvidence("the policy is archived, not destroyed", `archivedAt ${deleted?.archivedAt ?? "missing"}`, Boolean(deleted?.archivedAt));
    expect(deleted?.archivedAt).toBeTruthy();
    await owner.screenshot();
  });

  await step("after: Undo brings the same limit back with its team and amounts", async () => {
    await owner.click({ testId: "gateway-limit-undo" });
    await owner.see({ testId: "gateway-limit-row" }, { text: /\$20\.00 a day, \$300\.00 a month each/, timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-limit-deleted" });
    const restored = await design();
    evidence.recordAssertionEvidence("restored in place", `archivedAt ${restored?.archivedAt ?? null}; Design still assigned: ${Boolean(restored)}`, Boolean(restored) && !restored?.archivedAt);
    expect(restored?.archivedAt ?? null).toBeNull();
    await owner.screenshot();
  });

  await step("a teammate sees no Limits and is refused the limit list", async () => {
    const teammate = user.on(world.memberWeb);
    await teammate.navigate(limitsUrl);
    await teammate.notSee({ testId: "gateway-limits" }, { timeoutMs: 30_000 });
    await teammate.notSee({ testId: "gateway-limit-new" });
    const listed = await probe.api(world.teammate, policiesPath);
    evidence.recordAssertionEvidence("teammate is refused", `GET ${policiesPath} as teammate → ${listed.response.status}`, listed.response.status === 403);
    expect(listed.response.status).toBe(403);
    await teammate.screenshot();
  });
});
