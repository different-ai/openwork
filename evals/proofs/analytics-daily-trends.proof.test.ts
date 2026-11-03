import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { analyticsDailyTrends } from "../worlds/analytics-daily-trends.ts";

const test = spec.world(analyticsDailyTrends, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

// DESIGN P4/P10: daily and weekly intervals each have a captioned screenshot.
test("an admin sees daily trends by default and switches to weekly", async ({ world, user, step, evidence }) => {
  await step("daily trends show one bar per day for the last 30 days, Daily selected", async () => {
    await user.see({ role: "heading", label: "Daily active users" }, { timeoutMs: 60_000 });
    await user.see({ role: "radio", label: "Daily" });
    await user.see({ text: "Last 30 days · UTC" });
    const { daily } = await world.analytics();
    const today = daily?.at(-1);
    const activeDays = (daily ?? []).filter((day) => Number(day.sessions) > 0).length;
    evidence.recordAssertionEvidence(
      "Default: 30 UTC days ending today, with today's sessions in the last bar",
      `days=${daily?.length}; today=${String(today?.day)}; today sessions=${String(today?.sessions)} (sent ${world.expectedTodaySessions}); days with activity=${activeDays}`,
      daily?.length === 30 && Number(today?.sessions) === world.expectedTodaySessions && activeDays === 8,
    );
    expect(daily).toHaveLength(30);
    expect(Number(today?.sessions)).toBe(world.expectedTodaySessions);
    await user.screenshot();
  });

  await step("the switch returns to the weekly charts without reloading", async () => {
    await user.click({ role: "radio", label: "Weekly" });
    await user.see({ role: "heading", label: "Weekly active users" });
    await user.see({ text: "Trends over 12 weeks" });
    await user.screenshot();
  });
});
