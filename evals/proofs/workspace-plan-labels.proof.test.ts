import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import { workspacePlanLabelsWorld } from "../worlds/workspace-plan-labels.ts";

const test = spec.world(workspacePlanLabelsWorld, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

async function workspaceRows(probe: Probe) {
  const names = await probe.dom('[data-testid="workspace-switcher-menu"] button span:first-child');
  const labels = await probe.dom('[data-testid="workspace-switcher-menu"] button span:nth-child(2)');
  return names.elements.map((element, index) => `${element.text} ${labels.elements[index]?.text ?? ""}`.replace(/\s+/g, " ").trim());
}

test("an owner and a member see the sandbox identity and real plans in the bottom-left workspace switcher", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner);
  const member = user.on(world.member);

  await step("after: the owner sees Sandbox and three members instead of Creator plan", async () => {
    await owner.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.see({ role: "button", label: /^Trial sandbox\s+Sandbox • 3 members$/ });
    const rows = await workspaceRows(probe.on(world.owner));
    const ok = rows.includes("Trial sandbox Sandbox • 3 members") && !rows.some((row) => row.includes("Creator plan"));
    evidence.recordAssertionEvidence("The sandbox is labeled from its identity, not the owner's role", rows.join("; "), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("ordinary workspaces still show their actual Free, Team and Enterprise plans", async () => {
    const expected = ["Free workspace Free plan • 3 members", "Team workspace Team plan • 1 member", "Enterprise workspace Enterprise plan • 1 member"];
    await owner.see({ role: "button", label: /^Enterprise workspace\s+Enterprise plan • 1 member$/ });
    const rows = await workspaceRows(probe.on(world.owner));
    const ok = expected.every((label) => rows.includes(label));
    evidence.recordAssertionEvidence("Ownership does not turn Free, Team or Enterprise into Creator", rows.join("; "), ok);
    expect(ok).toBe(true);
    await owner.screenshot();
  });

  await step("a member sees the same Sandbox label and member count without inheriting the owner's role", async () => {
    await member.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
    await member.click({ testId: "workspace-switcher-trigger" });
    await member.see({ role: "button", label: /^Trial sandbox\s+Sandbox • 3 members$/ });
    const rows = await workspaceRows(probe.on(world.member));
    const ok = rows.includes("Trial sandbox Sandbox • 3 members") && !rows.some((row) => /Trial sandbox.*(?:Free|Creator) plan/.test(row));
    evidence.recordAssertionEvidence("Joining as a member does not mislabel the sandbox as Free", rows.join("; "), ok);
    expect(ok).toBe(true);
    await member.screenshot();
  });
});
