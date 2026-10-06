import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { orgModelAnalyticsWorld } from "../worlds/org-model-analytics.ts";

const test = spec.world(orgModelAnalyticsWorld, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("an owner uses AI Gateway reporting without the retired Analytics section", async ({ world, user, probe, step, evidence }) => {
  await step("after: AI Gateway keeps its usage charts and reporting controls", async () => {
    await user.see({ role: "heading", label: "AI Gateway" }, { timeoutMs: 60_000 });
    await user.see({ testId: "gateway-usage" }, { timeoutMs: 60_000 });
    await user.see({ role: "button", label: /^Tokens$/ });
    await user.see({ role: "button", label: /^Cost$/ });
    await user.see({ label: "Group By" });
    await user.notSee({ role: "link", label: /^Analytics$/ });
    await user.notSee({ role: "link", label: /^Usage\ \&\ adoption$/ });
    await user.notSee({ role: "link", label: /^Models\ \&\ usage$/ });
    await user.notSee({ role: "link", label: /^Workflow\ Runs$/ });
    await user.screenshot();
    evidence.recordAssertionEvidence("AI Gateway is the reporting destination", "Gateway Usage retains Tokens, Cost, and Group By; no legacy Analytics links are displayed.", true);
  });

  await step("the owner can still switch the Gateway report from tokens to cost", async () => {
    await user.click({ role: "button", label: /^Cost$/ });
    await user.see({ text: /^Cost\ ·\ USD$/ });
    await user.click({ role: "button", label: /^Tokens$/ });
    await user.see({ text: /^Reported\ tokens$/ });
    await user.screenshot();
    evidence.recordAssertionEvidence("Gateway reporting remains interactive", "Cost displays Cost · USD; Tokens restores Reported tokens.", true);
  });

  await step("retired analytics APIs no longer collect or expose app usage", async () => {
    const paths = ["/v1/telemetry/analytics", "/v1/telemetry/adoption", "/v1/telemetry/dimensions", "/v1/workflow-runs", "/v1/codemode-runs"];
    const statuses: number[] = [];
    for (const path of paths) {
      const result = await probe.api(world.den.admin, path);
      statuses.push(result.response.status);
      expect(result.response.status, path).toBe(404);
    }
    await user.see({ testId: "gateway-usage" });
    evidence.recordAssertionEvidence("Legacy analytics APIs are removed", `${paths.join(", ")}: ${statuses.join(" / ")}; Gateway Usage remains available.`, statuses.every((status) => status === 404));
  });
});
