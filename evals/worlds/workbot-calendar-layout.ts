import { chrome } from "@openwork/hosts";
import { setViewport } from "@openwork/cdp";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { startMockGoogle } from "@openwork/labs";
import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";
import { startCalendarMock } from "../packages/labs/src/calendar-mock.mjs";
import { CALENDAR_ACCOUNT, calendarDenEnv, connectCalendarAccount } from "./automation-calendar.ts";
import { isRecord } from "./library.ts";
import { readCalendarRail, readCalendarStyle } from "./calendar-layout-witness.ts";
import { seedCalendarReconnectRecovery } from "./calendar-recovery-fixture.ts";

/** Canonical real Workbot/Den bootstrap, owning its recovery seed before the first browser act. */
export async function workbotCalendarLayout(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the Calendar recovery world needs its disposable local Den");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const resources = new AsyncDisposableStack();
  try {
    const calendar = await startCalendarMock({ timeZone: "America/Los_Angeles" });
    resources.defer(() => calendar.stop());
    const identity = resources.use(await startMockGoogle({ accounts: [CALENDAR_ACCOUNT], port: 0 }));
    const hosted = await bootWorkbot(resources, undefined, { live: false, calendar: true, denEnv: calendarDenEnv(identity, calendar.baseUrl) });
    await connectCalendarAccount(hosted.den.admin, identity, { providerKey: "google-workspace", name: "Google Workspace" });
    await connectCalendarAccount(hosted.den.admin, identity, { providerKey: "microsoft-365", name: "Microsoft 365" });
    const recovery = await seedCalendarReconnectRecovery(hosted.den, hosted.orgId);
    const login = await signInWorkbot(hosted);
    const app = resources.use(await chrome({ name: "workbot-calendar-layout", host: place.host(), headless: true, startUrl: "about:blank", mouse: true }));
    await setViewport(app, { width: 1440, height: 960, deviceScaleFactor: 1 });
    await app.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: hosted.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    await app.client.send("DOM.enable");
    await app.client.send("CSS.enable");
    return {
      app, url: hosted.workbotUrl, recovery,
      providerReads: () => calendar.state.requests.filter((request) => request.path.startsWith("/calendar/v3/") || request.path.startsWith("/v1.0/")).length,
      hourRail: () => readCalendarRail(app),
      async runRecoveryLayout() {
        const style = await readCalendarStyle(app, '[data-calendar-run-outcome][data-calendar-run-status="failed"]');
        return { whiteSpace: style.get("white-space"), textOverflow: style.get("text-overflow"), overflowX: style.get("overflow-x") };
      },
      /** Signed-in GET verifies that the person's form was saved by Workbot/Den, not just local state. */
      async savedAutomation(name: string) {
        const response = await login.call("/v1/workbot/calendar/v1/automations?limit=100");
        const body: unknown = await response.json();
        if (!response.ok || !isRecord(body) || !Array.isArray(body.items)) throw new Error(`Calendar list answered ${response.status}`);
        const item = body.items.find((entry) => isRecord(entry) && isRecord(entry.automation) && entry.automation.name === name);
        if (!isRecord(item) || !isRecord(item.automation) || !isRecord(item.revision)) throw new Error(`Missing saved ${name}`);
        return { id: item.automation.id, instructions: item.revision.instructions, executionTarget: item.revision.executionTarget };
      },
      [Symbol.asyncDispose]: () => resources.disposeAsync(),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
