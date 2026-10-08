import { denFetch } from "@openwork/behaviors";
import { chrome } from "@openwork/hosts";
import { setViewport } from "@openwork/cdp";
import { startMockGoogle } from "@openwork/labs";
import { localMysqlIsRunning, SkipError, type Place, type Seed } from "@openwork/env";
import { bootWorkbot, signInWorkbot } from "../../worlds/lib/workbot.ts";
import { startCalendarMock } from "../packages/labs/src/calendar-mock.mjs";
import { CALENDAR_ACCOUNT, calendarDenEnv, connectCalendarAccount } from "./automation-calendar.ts";
import { isRecord } from "./library.ts";

/**
 * The real Workbot world (Den, the headless runner and the Workbot app, as preview-workbot boots them) with the
 * Acme owner's seeded Automations and both Calendar features on. Alex's Google Calendar and Outlook are connected
 * through Den's OAuth against the identity mock, and Den's Google/Graph calls go to the calendar mock, so
 * Workbot's Calendar reads meetings through Workbot's server and Den exactly as with real accounts.
 */
export async function workbotCalendar(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("the Workbot world runs next to a local Den and MySQL");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const stack = new AsyncDisposableStack();
  try {
    const calendar = await startCalendarMock({ timeZone: "America/Los_Angeles" });
    stack.defer(() => calendar.stop());
    const identity = stack.use(await startMockGoogle({ accounts: [CALENDAR_ACCOUNT], port: 0 }));
    const world = await bootWorkbot(stack, undefined, { live: false, calendar: true, denEnv: calendarDenEnv(identity, calendar.baseUrl) });
    await connectCalendarAccount(world.den.admin, identity, { providerKey: "google-workspace", name: "Google Workspace" });
    await connectCalendarAccount(world.den.admin, identity, { providerKey: "microsoft-365", name: "Microsoft 365" });
    const login = await signInWorkbot(world);
    const app = stack.use(await chrome({ name: "workbot-calendar", host: place.host(), headless: true, startUrl: "about:blank", mouse: true }));
    await setViewport(app, { width: 1440, height: 960, deviceScaleFactor: 1 });
    await app.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: world.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    const admin = { authorization: `Bearer ${world.den.admin.token}` };
    const setFeature = async (key: "workbotCalendar" | "automationCalendar", value: boolean) => {
      const updated = await denFetch(world.den.admin, `/v1/admin/organizations/${world.orgId}/capabilities`, { method: "PUT", headers: admin, body: JSON.stringify({ capabilities: { [key]: value } }) });
      if (!updated.response.ok) throw new Error(`Could not set ${key}: HTTP ${updated.response.status}`);
    };
    return {
      app, url: world.workbotUrl,
      /** Den's effective features for Acme (both Calendars are separate switches). */
      async features() {
        const org = await denFetch(world.den.admin, "/v1/org", { headers: { ...admin, "x-openwork-org-id": world.orgId } });
        const features = isRecord(org.body) && isRecord(org.body.features) ? org.body.features : {};
        return { workbotCalendar: features.workbotCalendar === true, automationCalendar: features.automationCalendar === true };
      },
      turnOffWorkbotCalendar: () => setFeature("workbotCalendar", false),
      /** Workbot's own Calendar API as the signed-in member: Den decides whether it answers. */
      calendarApiStatus: async () => (await login.call("/v1/workbot/calendar/v1/automations?limit=5")).status,
      providerReads: () => calendar.state.requests.filter((request) => request.path.startsWith("/calendar/v3/") || request.path.startsWith("/v1.0/")).length,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
