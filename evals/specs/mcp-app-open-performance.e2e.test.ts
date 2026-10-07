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
  // A slower installed desktop finishes live discovery after a cached App has
  // already made its startup tool calls; those calls must not surface an error.
  const discoveryDelayMs = 1_500;
  let late: Awaited<ReturnType<typeof world.capture>> | undefined;
  await step("witness: live discovery answers after a cached chat App already called its tools", async () => {
    world.holdDiscovery(discoveryDelayMs);
    await world.begin();
    // The most recently seen chat App is still in the bounded presentation cache.
    await user.click({ role: "button", label: "Open 4" });
    await user.see({ testId: "measurement" }, { text: /paintMs/, timeoutMs: 60_000 });
    late = await world.capture("chat", "warm");
    const held = world.holdDiscovery(0);
    evidence.recordAssertionEvidence("Startup tool calls were made by the cached App before live discovery answered",
      `Live discovery was held ${discoveryDelayMs} ms (${held} held); the cached App painted at ${late.paintMs.toFixed(1)} ms and ran its startup tool calls while waiting.`,
      held >= 1 && late.paintMs < discoveryDelayMs);
    expect(held).toBeGreaterThanOrEqual(1);
    expect(late.paintMs).toBeLessThan(discoveryDelayMs);
  });
  await step("after: the cached App never shows \"MCP error -32603: This artifact view has closed or changed.\"", async () => {
    await user.see({ role: "button", label: "Close App" });
    await user.screenshot();
    evidence.recordAssertionEvidence("The waiting startup calls did not render an error in the App",
      `Errors observed across the cached and replacement App documents: ${late?.errors ?? "not measured"}.`,
      late?.errors === 0);
    expect(late?.errors).toBe(0);
    await user.click({ role: "button", label: "Close App" });
  });
});
