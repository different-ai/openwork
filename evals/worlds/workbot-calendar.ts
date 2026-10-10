import { denFetch } from "@openwork/behaviors";
import { chrome } from "@openwork/hosts";
import { evaluateOnSurface, setViewport } from "@openwork/cdp";
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
const PICKER_PROVIDER = "Anthropic launch-planning models with a deliberately long provider label for narrow screens";
const PICKER_MODELS = [
  { id: "atlas", name: "Atlas launch planning with a deliberately long model label for narrow screens" },
  { id: "beacon", name: "Beacon weekly reporting with a deliberately long model label for narrow screens" },
  { id: "cedar", name: "Cedar meeting preparation with a deliberately long model label for narrow screens" },
  { id: "delta", name: "Delta release coordination with a deliberately long model label for narrow screens" },
  { id: "elm", name: "Elm checklist review with a deliberately long model label for narrow screens" },
  { id: "finch", name: "Finch account research with a deliberately long model label for narrow screens" },
  { id: "grove", name: "Grove project planning with a deliberately long model label for narrow screens" },
  { id: "harbor", name: "Harbor document review with a deliberately long model label for narrow screens" },
  { id: "iris", name: "Iris owner follow-ups with a deliberately long model label for narrow screens" },
  { id: "juniper", name: "Juniper launch readiness with a deliberately long model label for narrow screens" },
  { id: "kestrel", name: "Kestrel status reporting with a deliberately long model label for narrow screens" },
  { id: "willow", name: "WillowWithoutAnyWordBreaksToStressNarrowModelMenusAndKeepTheProviderLogoAndSelectionIndicatorVisible" },
];

export async function workbotCalendar(_seed: Seed, { place }: { place: Place }, modelCount = PICKER_MODELS.length) {
  if (place.kind !== "local") throw new SkipError("the Workbot world runs next to a local Den and MySQL");
  if (!await localMysqlIsRunning()) throw new SkipError("local MySQL for a disposable openwork_eval_ database");
  const stack = new AsyncDisposableStack();
  try {
    const calendar = await startCalendarMock({ timeZone: "America/Los_Angeles" });
    stack.defer(() => calendar.stop());
    const identity = stack.use(await startMockGoogle({ accounts: [CALENDAR_ACCOUNT], port: 0 }));
    const world = await bootWorkbot(stack, undefined, { live: false, calendar: true, denEnv: calendarDenEnv(identity, calendar.baseUrl) });
    const admin = { authorization: `Bearer ${world.den.admin.token}` };
    const providerHeaders = { ...admin, "x-openwork-org-id": world.orgId };
    // Replace this disposable world's preview providers before the first act. The offered models, ordering and
    // long labels below are fixed fixtures, not whichever models the remote catalog happens to publish today.
    const providers = await denFetch(world.den.admin, "/v1/llm-providers", { headers: providerHeaders });
    if (!providers.response.ok || !isRecord(providers.body) || !Array.isArray(providers.body.llmProviders)) throw new Error("Could not read the world's model providers");
    for (const provider of providers.body.llmProviders) {
      if (!isRecord(provider) || typeof provider.id !== "string") throw new Error("Invalid preview model provider");
      const removed = await denFetch(world.den.admin, `/v1/llm-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE", headers: providerHeaders });
      if (!removed.response.ok) throw new Error(`Could not replace preview provider: HTTP ${removed.response.status}`);
    }
    const pickerModels = PICKER_MODELS.slice(0, modelCount);
    const published = await denFetch(world.den.admin, "/v1/llm-providers", {
      method: "POST", headers: providerHeaders,
      body: JSON.stringify({
        name: PICKER_PROVIDER, source: "custom", apiKey: "calendar-picker-fixture-not-a-real-key", allMembers: true,
        customConfig: {
          id: "anthropic", name: PICKER_PROVIDER, npm: "@ai-sdk/anthropic", env: ["ANTHROPIC_API_KEY"],
          // Selection and saving stay real; this journey never asks any selected model to run.
          api: "http://127.0.0.1:9/v1",
          models: pickerModels.map((model) => ({ ...model, tool_call: true, limit: { context: 200_000, output: 8_000 } })),
        },
      }),
    });
    const provider = isRecord(published.body) && isRecord(published.body.llmProvider) ? published.body.llmProvider : null;
    if (!published.response.ok || typeof provider?.id !== "string") throw new Error(`Could not publish picker fixtures: HTTP ${published.response.status}`);
    const pickerProviderId = provider.id;
    await connectCalendarAccount(world.den.admin, identity, { providerKey: "google-workspace", name: "Google Workspace" });
    await connectCalendarAccount(world.den.admin, identity, { providerKey: "microsoft-365", name: "Microsoft 365" });
    const login = await signInWorkbot(world);
    const app = stack.use(await chrome({ name: "workbot-calendar", host: place.host(), headless: true, startUrl: "about:blank", mouse: true }));
    await setViewport(app, { width: 1440, height: 960, deviceScaleFactor: 1 });
    await app.client.send("Network.setCookies", { cookies: login.cookie.split("; ").map((entry) => {
      const split = entry.indexOf("=");
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: world.workbotUrl, httpOnly: true, sameSite: "Lax" };
    }) });
    const setFeature = async (key: "workbotCalendar" | "automationCalendar", value: boolean) => {
      const updated = await denFetch(world.den.admin, `/v1/admin/organizations/${world.orgId}/capabilities`, { method: "PUT", headers: admin, body: JSON.stringify({ capabilities: { [key]: value } }) });
      if (!updated.response.ok) throw new Error(`Could not set ${key}: HTTP ${updated.response.status}`);
    };
    return {
      app, url: world.workbotUrl,
      pickerModels, pickerProviderName: PICKER_PROVIDER, pickerProviderId,
      // probe.dom omits computed visibility and hidden ancestors. Observe paint, not unmount: Base UI Select
      // intentionally keeps hidden options registered for typeahead when focus returns to its trigger.
      modelListPaintState: () => evaluateOnSurface(app, () => {
        const trigger = document.querySelector('[aria-label="Model"][aria-expanded]');
        const lists = Array.from(document.querySelectorAll('[role="listbox"]'), (list) => {
          const rect = list.getBoundingClientRect();
          let hiddenBy: string | null = null;
          for (let ancestor: Element | null = list; ancestor; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) {
              hiddenBy = `${ancestor.tagName.toLowerCase()}: display ${style.display}, visibility ${style.visibility}, opacity ${style.opacity}`;
              break;
            }
          }
          return {
            width: rect.width, height: rect.height, hiddenBy,
            painted: hiddenBy === null && rect.width > 0 && rect.height > 0
              && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight,
          };
        });
        return {
          retained: lists.length, painted: lists.filter((list) => list.painted).length, lists,
          triggerExists: trigger !== null, expanded: trigger?.getAttribute("aria-expanded") === "true",
          triggerFocused: trigger === document.activeElement,
        };
      }),
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

/** The same real Calendar journey with two deterministic models, below the search threshold. */
export function workbotCalendarShortList(seed: Seed, context: { place: Place }) {
  return workbotCalendar(seed, context, 2);
}
