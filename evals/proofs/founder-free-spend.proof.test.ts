import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { founderFreeSpendWorld } from "../worlds/founder-free-spend.ts";

const test = spec.world(founderFreeSpendWorld, {
  timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] },
});

test("the platform admin sees settled free spend across a founder’s new organizations", async ({ world, user, probe, step, evidence }) => {
  const id = "security-finding-organization-creation";
  await step("before: one new workspace has spent money and the other is unused", async () => {
    await user.click({ text: /checks? with nothing to review/ });
    await user.see({ text: "No founder used free models in two or more new organizations." });
    const row = (await probe.dom(`[data-testid="${id}"]`)).elements[0];
    expect(row?.text).toContain("Clear");
    await user.screenshot();
  });
  await step("after: two new workspaces have spent five dollars together", async () => {
    await world.settleSecond();
    await user.reload();
    await user.click({ text: "Free spend across new organizations" });
    await user.see({ text: "$5.00 across 2 new organizations" });
    const row = (await probe.dom(`[data-testid="${id}"]`)).elements[0];
    const ok = Boolean(row?.text.includes("Medium") && row.text.includes("Spend") && row.text.includes("$5.00"));
    evidence.recordAssertionEvidence("The founder is ranked by settled spend", row?.text ?? "", ok);
    expect(ok).toBe(true);
    await user.screenshot();
  });
});
