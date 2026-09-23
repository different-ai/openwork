import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewaySpendLimits } from "../worlds/ai-gateway-spend-limits.ts";

const test = spec.world(aiGatewaySpendLimits, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

type Policy = { id: string; name: string; revision: number; archivedAt?: string | null; limits: { timeframe: string; costLimitMicroUsd: number }[]; assignments: { teamId: string | null }[] };

function policies(body: unknown): Policy[] {
  const list = body && typeof body === "object" && "policies" in body ? body.policies : [];
  return Array.isArray(list) ? list.filter((entry): entry is Policy => typeof entry === "object" && entry !== null && "id" in entry) : [];
}

test("an owner gives the Design team $20 a day and $300 a month each, deletes it, and brings it back with Undo", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
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

  await step("the owner picks the Design team and turns on a daily and a monthly amount", async () => {
    await owner.click({ testId: "gateway-limit-new" });
    await owner.see({ testId: "gateway-limit-editor" }, { timeoutMs: 30_000 });
    await owner.click({ role: "switch", label: "Everyone in the organization" });
    await owner.click({ testId: "gateway-limit-add-team" });
    await owner.click({ role: "combobox", label: "Team" });
    await owner.click({ role: "option", label: /Design/ });
    await owner.see({ testId: "gateway-limit-who-row" }, { text: /Design/ });
    await owner.click({ role: "switch", label: "Limit per day" });
    await owner.type({ testId: "gateway-limit-amount-day" }, "20");
    await owner.type({ testId: "gateway-limit-amount-month" }, "300");
    await owner.see({ testId: "gateway-limit-period-day" }, { text: /Resets every day/ });
    await owner.see({ testId: "gateway-limit-period-month" }, { text: /Resets on the 1st/ });
    await owner.screenshot();
  });

  await step("after: Limits shows one Design row with both amounts, applied to each person", async () => {
    await owner.click({ testId: "gateway-limit-save" });
    await owner.see({ testId: "gateway-limit-row" }, { text: /\$20\.00 a day, \$300\.00 a month each/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-limit-row" }, { text: /Pauses them/ });
    const saved = await design();
    const limits = Object.fromEntries((saved?.limits ?? []).map((limit) => [limit.timeframe, limit.costLimitMicroUsd]));
    evidence.recordAssertionEvidence("saved as one policy assigned to Design", `name "${saved?.name}"; day ${limits.day}; month ${limits.month}; team assignments ${saved?.assignments.length}`, limits.day === 20_000_000 && limits.month === 300_000_000);
    expect(limits).toEqual({ day: 20_000_000, month: 300_000_000 });
    await owner.screenshot();
  });

  await step("Users & Teams: Teams, then Design, lists its people under Design's limit", async () => {
    await owner.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway?tab=users-and-teams`);
    await owner.see({ testId: "gateway-directory-everyone" }, { timeoutMs: 60_000 });
    await owner.click({ role: "radio", label: /Teams/ });
    await owner.see({ testId: "gateway-directory-team-row" }, { text: /Design[\s\S]*\$20\.00 a day, \$300\.00 a month each[\s\S]*Team limit/, timeoutMs: 30_000 });
    await owner.screenshot();
    await owner.click({ testId: "gateway-directory-team-row" });
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
