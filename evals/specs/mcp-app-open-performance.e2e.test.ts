import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { mcpAppOpenPerformance } from "../worlds/mcp-app-open-performance.ts";

const test = spec.world(mcpAppOpenPerformance, { resources: { surfaces: ["appWeb"], services: ["den", "mock"] }, timeout: 420_000 });

test("seen Apps paint quickly in chat and Dashboard, with live actions and no error flash", async ({ world, user, step, evidence }) => {
  await user.see({ role: "button", label: "Open 0" }, { timeoutMs: 60_000 });
  await step("before: An App has not been opened on this device", async () => { await user.screenshot(); });
  for (const surface of ["chat", "dashboard"] as const) {
    for (let sample = 0; sample < 5; sample++) {
      const index = sample + (surface === "dashboard" ? 5 : 0);
      for (const temperature of ["cold", "warm"] as const) {
        await step(`${surface} ${temperature} open ${sample + 1}`, async () => {
          await world.begin();
          await user.click({ role: "button", label: `Open ${index}` });
          await user.see({ testId: "measurement" }, { text: /paintMs/, timeoutMs: 60_000 });
          const measured = await world.capture(surface, temperature);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1") expect(measured.errors).toBe(0);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1") expect(measured.paintMs).toBeLessThan(temperature === "warm" ? 1_000 : 2_500);
          if (process.env.OPENWORK_MCP_APP_BASELINE !== "1" && temperature === "warm") {
            expect(measured.stages.filter(stage => stage.stage.endsWith("desktop.resources-read"))).toHaveLength(0);
          }
          if (sample === 0 && temperature === "warm") await step(`after: ${surface} reopens from cache without an error flash`, async () => { await user.screenshot(); });
          await user.click({ role: "button", label: "Close App" });
        });
      }
    }
  }
  await world.save();
  if (process.env.OPENWORK_MCP_APP_BASELINE !== "1") {
    for (const surface of ["chat", "dashboard"] as const) for (const temperature of ["cold", "warm"] as const) {
      const samples = world.samples.filter(sample => sample.surface === surface && sample.temperature === temperature);
      const paints = samples.map(sample => sample.paintMs).sort((a, b) => a - b);
      const budget = temperature === "warm" ? 1_000 : 2_500;
      const htmlReads = samples.map(sample => sample.stages.filter(stage => stage.stage.endsWith("desktop.resources-read")).length);
      evidence.recordAssertionEvidence(`${surface} ${temperature} opens meet the paint budget without an error flash`,
        `Five real App opens: median observed paint ${paints[2].toFixed(1)} ms, slowest ${paints[4].toFixed(1)} ms, budget ${budget} ms. `
        + `Error observation continued through startup tool calls: ${samples.reduce((sum, sample) => sum + sample.errors, 0)} errors. `
        + `HTML reads per open: ${htmlReads.join(", ")}. Each view still obtains a fresh live binding.`,
        samples.length === 5 && samples.every(sample => sample.errors === 0 && sample.paintMs < budget)
        && (temperature !== "warm" || htmlReads.every(reads => reads === 0)));
    }
  }
});
