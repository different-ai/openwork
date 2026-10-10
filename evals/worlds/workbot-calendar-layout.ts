import type { Place, Seed } from "@openwork/env";
import { workbotCalendar } from "./workbot-calendar.ts";
import { isRecord } from "./library.ts";
import { readCalendarRail, readCalendarStyle } from "./calendar-layout-witness.ts";

/** The real Den-backed Calendar world, with read-only CSS and saved-body witnesses for layout repairs. */
export async function workbotCalendarLayout(seed: Seed, context: { place: Place }) {
  const world = await workbotCalendar(seed, context);
  try {
    await world.app.client.send("DOM.enable");
    await world.app.client.send("CSS.enable");
    return {
      ...world,
      hourRail: () => readCalendarRail(world.app),
      async runRecoveryLayout() {
        const style = await readCalendarStyle(world.app, '[data-calendar-run-outcome][data-calendar-run-status="failed"]');
        return { whiteSpace: style.get("white-space"), textOverflow: style.get("text-overflow"), overflowX: style.get("overflow-x") };
      },
      /** A GET with the browser's signed-in cookie: proves the UI saved through Workbot/Den, not local state. */
      async savedAutomation(name: string) {
        const result = await world.app.client.send("Network.getCookies", { urls: [world.url] });
        if (!isRecord(result) || !Array.isArray(result.cookies)) throw new Error("Missing signed-in cookies");
        const cookie = result.cookies.flatMap((entry) => isRecord(entry) && typeof entry.name === "string" && typeof entry.value === "string" ? [`${entry.name}=${entry.value}`] : []).join("; ");
        const response = await fetch(`${world.url}/v1/workbot/calendar/v1/automations?limit=100`, { headers: { cookie }, signal: AbortSignal.timeout(15_000) });
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || !Array.isArray(body.items)) throw new Error(`Calendar list answered ${response.status}`);
        const item = body.items.find((entry) => isRecord(entry) && isRecord(entry.automation) && entry.automation.name === name);
        if (!isRecord(item) || !isRecord(item.automation) || !isRecord(item.revision)) throw new Error(`Missing saved ${name}`);
        return { id: item.automation.id, instructions: item.revision.instructions, executionTarget: item.revision.executionTarget };
      },
      [Symbol.asyncDispose]: () => world[Symbol.asyncDispose](),
    };
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}
