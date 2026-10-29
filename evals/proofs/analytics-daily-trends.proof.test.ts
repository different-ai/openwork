import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { analyticsDailyTrends } from "../worlds/analytics-daily-trends.ts";

const test = spec.world(analyticsDailyTrends, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

// DESIGN P4: the weekly view stays the fallback when the rollout is off;
// P10: both states have a real, captioned screenshot.
test("an admin switches Usage & adoption from weekly to daily trends and back", async ({ world, user, step, evidence }) => {
  await step("before: with daily trends off, the page charts 12 weeks and has no interval switch", async () => {
    await user.see({ role: "heading", label: "Weekly active users" }, { timeoutMs: 90_000 });
    await user.notSee({ role: "radio", label: "Daily" });
    const { daily, weekly } = await world.analytics();
    evidence.recordAssertionEvidence("Off: the API sends only the weekly trend", `daily present=${daily !== null}; weeks=${weekly.length}`, daily === null && weekly.length === 12);
    expect(daily).toBeNull();
    await user.screenshot();
  });

  await step("after: turning daily trends on shows one bar per day for the last 30 days, Daily selected", async () => {
    await world.setDaily(true);
    await user.reload();
    await user.see({ role: "heading", label: "Daily active users" }, { timeoutMs: 60_000 });
    await user.see({ role: "radio", label: "Daily" });
    await user.see({ text: "Last 30 days · UTC" });
    const { daily } = await world.analytics();
    const today = daily?.at(-1);
    const activeDays = (daily ?? []).filter((day) => Number(day.sessions) > 0).length;
    evidence.recordAssertionEvidence(
      "On: 30 UTC days ending today, with today's sessions in the last bar",
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
