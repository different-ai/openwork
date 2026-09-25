import { browserScript, coworker, evalIn, spec, type Probe, type User } from "@openwork/testkit";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { activityEvent, activityOutcome, activityPrompts, activityReplies, allHandsModel, eventOutcome, weeklyOutcomes, weeklyPrompts, weeklyReplies, weeklyReview } from "../packages/labs/src/mock-all-hands-model.ts";
import { record } from "../packages/labs/src/scripted-tool-model.ts";
import { clickCoworkerControl } from "../worlds/coworker.ts";

function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error("Native record unavailable");
  return value;
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Native records unavailable");
  return value.map(object);
}

async function diagnoseViewAnimation(app: Awaited<ReturnType<typeof coworker>>, capture: () => Promise<unknown>) {
  const snapshot = async (stage: string) => {
    const state = await evalIn(app, () => {
      const view = document.querySelector<HTMLElement>('[data-testid="coworker-workspace"] > .view-enter');
      const style = view ? getComputedStyle(view) : null;
      const serial = (value: unknown): number | string | null => value == null ? null : typeof value === "number" && Number.isFinite(value) ? value : String(value);
      return {
        performanceNow: performance.now(), timelineCurrentTime: serial(document.timeline.currentTime),
        visibilityState: document.visibilityState, hasFocus: document.hasFocus(), found: Boolean(view),
        style: style ? { opacity: style.opacity, transform: style.transform, animation: style.animation, animationName: style.animationName, animationPlayState: style.animationPlayState } : null,
        animations: view?.getAnimations().map((animation) => ({
          name: animation instanceof CSSAnimation ? animation.animationName : animation.id,
          pending: animation.pending, startTime: serial(animation.startTime), currentTime: serial(animation.currentTime),
          playState: animation.playState, playbackRate: animation.playbackRate,
          computedTiming: animation.effect ? Object.fromEntries(Object.entries(animation.effect.getComputedTiming()).map(([key, value]) => [key, serial(value)])) : null,
        })) ?? [],
      };
    }, { timeoutMs: 5_000, reattachAttempts: 0 });
    console.log(`[coworker-view-animation] ${JSON.stringify({ stage, ...state })}`);
  };
  await snapshot("before-capture-1");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await snapshot("before-capture-2");
  await capture();
  await snapshot("after-capture");
}

async function reloadNativeView(user: User, probe: Probe) {
  await user.reload();
  await expect.poll(async () => (await probe.dom('[data-testid="coworker-workspace"] > .view-enter')).elements.length, { timeout: 30_000 }).toBe(1);
  // This native surface needs a real captured frame after reload to advance its hidden document timeline.
  // Keep CSS motion and the ordinary visibility/hit-test assertions unchanged; never retry the capture.
  await user.screenshot();
  await user.see({ testId: "coworker-rail" }, { timeoutMs: 5_000 });
}

const test = spec.world(async () => {
  const stack = new AsyncDisposableStack();
  const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-events-"));
  try {
    stack.defer(() => rm(profileDir, { recursive: true, force: true }));
    const model = stack.use(await allHandsModel());
    const sdk = process.env.OPENWORK_EVAL_COWORKER_SDK_DIRECTORY;
    if (!sdk) throw new Error("Provide an already-cached OPENWORK_EVAL_COWORKER_SDK_DIRECTORY; no SDK install is authorized.");
    const entry = process.env.OPENWORK_EVAL_ELECTRON_ENTRY;
    if (!entry) throw new Error("Provide OPENWORK_EVAL_ELECTRON_ENTRY from this worktree's current native bundle.");
    const binary = process.env.OPENWORK_EVAL_COWORKER_OPENCODE_BINARY || "opencode";
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => /^(OPENCODE_|COWORKER_)/.test(key) || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
    const env = {
      ...cleared,
      HOME: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "xdg-config"), XDG_DATA_HOME: join(profileDir, "xdg-data"),
      XDG_CACHE_HOME: join(profileDir, "xdg-cache"), XDG_STATE_HOME: join(profileDir, "xdg-state"),
      COWORKER_HOME_DIR: join(profileDir, "coworkers"), COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"), COWORKER_DEN_BASE_URL: model.baseUrl,
      OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"), OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"), OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_SERVER_URL: "", OPENWORK_SERVER_TOKEN: "", OPENWORK_POLICY_TOKEN: "", OPENWORK_UI_CONTROL_DISCOVERY: "",
      OPENWORK_OPENCODE_BIN: binary, OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"), OPENCODE_DB: join(profileDir, "opencode.db"),
      CODEX_HOME: join(profileDir, "codex"), CLAUDE_CONFIG_DIR: join(profileDir, "claude"),
      OLLAMA_HOST: "127.0.0.1:9", LMSTUDIO_HOST: "127.0.0.1:9", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_INSTALL: "1",
      OPENWORK_EVAL_ELECTRON_ENTRY: entry,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        enabled_providers: ["eval-team"], provider: {
          "eval-team": { npm: "@ai-sdk/openai-compatible", name: "Team fixture", options: { baseURL: model.baseUrl, apiKey: "eval-key" }, models: { team: { name: "Team", tool_call: true }, conversation: { name: "Conversation fixture", tool_call: true } } },
        }
      }),
    };
    const version = (await promisify(execFile)(binary, ["--version"], { env: { ...process.env, ...env }, timeout: 10_000 })).stdout.trim();
    expect(object(JSON.parse(await readFile(join(sdk, "node_modules/@opencode-ai/plugin/package.json"), "utf8"))).version).toBe(version);
    for (const directory of [join(env.XDG_CONFIG_HOME, "opencode"), env.OPENCODE_CONFIG_DIR]) {
      await mkdir(directory, { recursive: true });
      await cp(join(sdk, "node_modules"), join(directory, "node_modules"), { recursive: true, dereference: true });
    }
    const app = stack.use(await coworker({ name: "calendar-events", profileDir, env }));
    const invoke = async (command: string, payload: unknown = {}) => {
      // No automatic replay of bridge writes, including arrangement failures.
      const envelope = object(await evalIn(app, browserScript(async (command, payload): Promise<unknown> => {
        const bridge: unknown = Reflect.get(window, "__COWORKER__");
        if (!recordBridge(bridge)) throw new Error("Coworker bridge unavailable");
        function recordBridge(value: unknown): value is { invoke: (command: string, payload: unknown) => Promise<unknown> } {
          return typeof value === "object" && value !== null && "invoke" in value && typeof value.invoke === "function";
        }
        return bridge.invoke(command, payload);
      }, [command, payload]), { timeoutMs: 120_000, reattachAttempts: 0 }));
      if (envelope.ok !== true) throw new Error(`Bridge failed: ${command}: ${String(envelope.error)}`);
      return envelope.result;
    };
    await invoke("settings.update", { automaticMemoryEnabled: false, features: { calendar: true, notifications: true } });
    for (const name of ["Scout", "Editor"]) {
      await invoke("coworkers.create", { name, role: "Launch reviewer", mission: "Review the launch without external action.", avatarColor: "blue", avatarGlasses: "round" });
      await invoke("coworkers.update", { slug: name.toLowerCase(), patch: { model: "eval-team/team", modelVariant: "", modelMode: "fixed", modelChosenBy: "person", useAppModelDefaults: name === "Editor" } });
    }
    const runtime = object(await invoke("runtime.info"));
    if (typeof runtime.serverUrl !== "string" || new URL(runtime.serverUrl).hostname !== "127.0.0.1" || typeof runtime.ownerToken !== "string") throw new Error("Expected isolated loopback runtime");
    for (const slug of ["scout", "editor", "coordinator"]) {
      const workspace = object(await invoke(slug === "coordinator" ? "coordinator.ensure" : "coworkers.ensureWorkspace", { slug }));
      const response = await fetch(`${runtime.serverUrl}/workspace/${workspace.workspaceId}/opencode/provider`, { headers: { Authorization: `Bearer ${runtime.ownerToken}` }, signal: AbortSignal.timeout(30_000) });
      expect(response.ok).toBe(true);
      expect(await response.json()).toMatchObject({ connected: ["eval-team"] });
    }
    // Arrange a pre-existing private owner document, not an event-owned copy.
    await invoke("coworkers.files.write", { slug: "scout", path: "documents/launch-notes.md", content: "---\nid: launch-notes\ntitle: Launch notes\nrevision: 1\nstatus: active\n---\nPrivate owner notes: keep this document with Scout.\n" });
    const document = await invoke("documents.read", { slug: "scout", id: "launch-notes" });
    const responsibility = await invoke("localResponsibilities.create", { slug: "scout", name: "Review launch notes", instructions: "Review the notes without external action.", schedule: { kind: "once", at: Date.now() + 3_600_000, timezone: "UTC" } });
    return { app, model, invoke, document, responsibility, [Symbol.asyncDispose]: () => stack.disposeAsync() };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}, { needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"], env: ["OPENWORK_EVAL_ELECTRON_BINARY", "OPENWORK_EVAL_ELECTRON_ENTRY", "OPENWORK_EVAL_COWORKER_SDK_DIRECTORY"] }, timeout: 300_000 });

test("Calendar All Hands runs once through its native lead and preserves owner documents", { timeout: 360_000 }, async ({ world, user, probe, step, evidence }) => {
  const { invoke, model } = world;
  const select = (label: string, value: string) => evalIn(world.app, browserScript((label, value) => {
    // Legacy Coworker select adapter: actual form state, never an Event bridge write.
    const field = [...document.querySelectorAll<HTMLSelectElement>('[data-testid="event-editor"] select')].find((field) => field.closest("label")?.querySelector("span")?.textContent === label);
    if (!field || ![...field.options].some((option) => option.value === value)) throw new Error(`No ${label} option ${value}`);
    field.value = value;
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }, [label, value]), { reattachAttempts: 0 });
  let eventId = "", groupId = "", runId = "";
  const future = new Date();
  future.setDate(future.getDate() + 1);
  future.setHours(9, 0, 0, 0);
  const dateKey = `${future.getFullYear()}-${String(future.getMonth() + 1).padStart(2, "0")}-${String(future.getDate()).padStart(2, "0")}`;
  const objective = "Review launch readiness and agree on the next question without taking external action.";
  const detail = async () => {
    const value = object(await invoke("events.get", { id: eventId }));
    return { event: object(value.event), runs: records(value.runs) };
  };
  try {
    await reloadNativeView(user, probe);
    await step("Settings saves one shared Conversation choice without changing personal models or other defaults", async () => {
      const before = object(await invoke("settings.get"));
      await clickCoworkerControl(world.app, { testId: "coworker-profile-button" });
      await user.click({ role: "button", label: "Model defaults" });
      await user.see({ text: "Changes save automatically." });
      expect((await probe.dom('[data-testid="app-model-defaults"] section h2')).elements.map((item) => item.text)).toEqual(["Conversation", "Deep thinking", "Delivery", "Chat turn assignment"]);
      await user.notSee({ role: "button", label: "All Hands" });
      await user.click({ role: "button", label: /^Automatic \(role-appropriate\)/, nth: 0 });
      await user.type({ label: "Search AI models" }, "conversation", { replace: true });
      await user.click({ role: "button", label: /^Conversation fixture.*eval-team\/conversation/s });
      await user.see({ text: "Model defaults saved." });
      expect(await invoke("settings.get")).toEqual({ ...before, modelDefaults: { ...object(before.modelDefaults), conversation: { model: "eval-team/conversation", modelVariant: "" } } });
      for (const slug of ["editor", "scout"]) expect(await invoke("coworkers.get", { slug })).toMatchObject({ model: "eval-team/team", modelVariant: "", useAppModelDefaults: slug === "editor" });
      await user.screenshot();
      await user.click({ label: "Close settings" });
    });
    await step("Calendar stays usable beside an unsaved slot draft until the person creates the event", async () => {
      await user.click({ label: "Chat" });
      await user.click({ testId: "coworker-rail-row", label: "Editor" });
      await user.see({ role: "textbox", label: "Message Editor" });
      expect((await probe.dom('[data-testid="chat-rail-content"] input[type="checkbox"], [data-testid="group-filter-menu"]')).elements).toHaveLength(0);
      await user.click({ testId: "group-filter-trigger" });
      await user.see({ testId: "group-filter-menu" }, { text: /Group chats.*Events/s });
      expect((await probe.dom('[data-testid="group-filter-menu"][role="menu"] [role="menuitemcheckbox"]')).elements.map((item) => item.text)).toEqual(["Group chats", "Events"]);
      await user.click({ testId: "group-filter-trigger" });
      await user.notSee({ testId: "group-filter-menu" });
      await user.see({ testId: "coworker-calendar-shortcut", label: "Open Scout's calendar" });
      expect((await probe.dom('[data-testid="coworker-rail-row"] [data-testid="coworker-calendar-shortcut"]')).elements).toHaveLength(0);
      expect((await probe.dom('[data-testid="coworker-calendar-shortcut"][aria-label="Open Scout\'s calendar"] svg')).elements[0]!.rect.width).toBe(14);
      await user.screenshot();
      await user.type({ label: "Search coworkers" }, "Launch", { replace: true });
      await user.click({ testId: "coworker-calendar-shortcut", label: "Open Scout's calendar" });
      await user.see({ testId: "calendar-sidebar" }, { text: /Your team's calendar/ });
      await user.see({ label: "Search calendars" }, { value: "" });
      await user.notSee({ testId: "chat-rail-content" });
      await user.notSee({ testId: "group-filter-trigger" });
      const navigation = await probe.dom('[data-testid="main-content-switch"]');
      const search = await probe.dom('[data-testid="coworker-rail"] input[aria-label="Search calendars"]');
      expect(navigation.elements).toHaveLength(1);
      expect((await probe.dom('[data-testid="coworker-rail"] [data-testid="main-content-switch"]')).elements).toHaveLength(1);
      expect(navigation.elements[0]!.rect.bottom).toBeLessThanOrEqual(search.elements[0]!.rect.top);
      expect((await probe.dom('[data-testid="coworker-rail"] [data-testid="calendar-sidebar"]')).elements).toHaveLength(1);
      expect((await probe.dom('[data-testid="coworker-calendar"] [data-testid="calendar-sidebar"], [data-testid="coworker-calendar"] [aria-label="Filter calendar"]')).elements).toHaveLength(0);
      expect((await probe.dom('[data-testid="calendar-sidebar"] [aria-label="Calendar coworkers"] label:has(input:checked)')).elements.map((item) => item.text)).toEqual(["Scout"]);
      await user.see({ testId: "calendar-week" });
      expect((await probe.dom('[data-testid="calendar-week"] section[data-date]')).elements).toHaveLength(7);
      await user.see({ testId: "calendar-item", label: /Review launch notes.*Scheduled.*Responsibility/s });
      await user.click({ role: "checkbox", label: "Responsibilities" });
      await user.notSee({ testId: "calendar-item", label: /Review launch notes/ });
      const filters = await probe.storage("coworker.calendar.preferences.v1");
      expect(filters).toMatchObject({ coworkerSlugs: ["scout"], responsibilities: false });
      await user.click({ label: "Chat" });
      await user.see({ role: "textbox", label: "Message Editor" });
      expect((await probe.dom('[data-testid="coworker-rail-row"][data-slug="editor"][data-active="true"]')).elements).toHaveLength(1);
      await user.see({ label: "Search coworkers" }, { value: "Launch" });
      await user.notSee({ testId: "calendar-sidebar" });
      await user.type({ label: "Search coworkers" }, "", { replace: true });
      await user.click({ label: "Calendar" });
      await user.see({ testId: "calendar-sidebar" });
      expect(await probe.storage("coworker.calendar.preferences.v1")).toEqual(filters);
      expect((await probe.dom('[data-testid="calendar-sidebar"] [aria-label="Calendar sources"] label:has(input:checked)')).elements.map((item) => item.text)).toEqual(["Events"]);
      await user.notSee({ testId: "calendar-item", label: /Review launch notes/ });
      await user.click({ role: "checkbox", label: "Responsibilities" });
      await user.click({ role: "checkbox", label: "Everyone" });
      expect(await probe.storage("coworker.calendar.preferences.v1")).toMatchObject({ coworkerSlugs: null, responsibilities: true });
      await user.click({ testId: "calendar-item", label: /Review launch notes/ });
      await user.see({ testId: "calendar-responsibility-detail" }, { text: /Scheduled, not yet an execution receipt.*This computer/s });
      await user.click({ label: "Close event" });
      expect(model.prompts).toHaveLength(0);
      await user.click({ role: "button", text: "Month" });
      await user.see({ testId: "calendar-month" });
      const month = (await probe.dom('[data-testid="calendar-month"] section[data-date]')).elements;
      expect([35, 42]).toContain(month.length);
      expect(month[0]!.rect.top).toBe(month[6]!.rect.top);
      expect(month[7]!.rect.top).toBeGreaterThan(month[0]!.rect.top);
      expect((await probe.dom(`[data-testid="calendar-month"] [data-date="${dateKey}"] [data-testid="calendar-item"]`)).elements).toHaveLength(0);
      await user.click({ label: `Create event on ${future.toLocaleDateString(undefined, { dateStyle: "full" })} at 9 AM` });
      await user.see({ testId: "event-editor" });
      await user.see({ label: /^Title$/i }, { value: "" });
      await user.see({ label: /^Start$/i }, { value: `${dateKey}T09:00` });
      expect(await invoke("events.list")).toEqual([]);
      await select("Template", "all-hands");
      await user.see({ label: /^Title$/i }, { value: "All Hands" });
      await user.type({ label: /^Goal\b/i }, objective, { replace: true });
      await select("Owner", "editor");
      await user.see({ label: /^Owner/i }, { value: "editor" });
      await user.click({ label: "Remove Editor from participants" });
      await user.see({ label: /^Owner/i }, { value: "" });
      await user.click({ label: "Remove Scout from participants" });
      await user.type({ label: "Participants" }, "ED", { replace: true });
      await user.see({ role: "option", label: /^Editor/ });
      await user.press("Enter");
      await user.see({ label: "Remove Editor from participants" });
      expect(await invoke("events.list")).toEqual([]);
      await user.type({ label: "Participants" }, "sc", { replace: true });
      await user.see({ label: "Available coworkers" }, { text: /Scout/ });
      await user.see({ role: "option", label: /^Scout/ });
      await user.notSee({ role: "option", label: /^Editor/ });
      await user.screenshot();
      await user.click({ role: "option", label: /^Scout/ });
      await select("Owner", "editor");
      await user.see({ label: "Remove Scout from participants" });
      await user.see({ label: /^Owner/i }, { value: "editor" });
      // The date header changes the live grid, not the draft's accepted start time.
      await user.click({ label: `Show ${future.toLocaleDateString()} in Day view` });
      for (const mode of ["day", "week"]) {
        if (mode === "week") await user.click({ role: "button", text: "Week" });
        await user.see({ testId: `calendar-${mode}` });
        expect((await probe.dom(`[data-testid="calendar-${mode}"] section[data-date]`)).elements).toHaveLength(mode === "day" ? 1 : 7);
        expect((await probe.dom(`[data-testid="calendar-${mode}"] [data-date="${dateKey}"] [data-testid="calendar-time-slot"]`)).elements).toHaveLength(48);
        expect((await probe.dom(`[data-testid="calendar-${mode}"] [data-starts-at="${future.getTime()}"]`)).elements).toHaveLength(1);
        await user.see({ label: /^Title$/i }, { value: "All Hands" });
        await user.see({ label: /^Goal\b/i }, { value: objective });
        await user.see({ label: /^Start$/i }, { value: `${dateKey}T09:00` });
        expect(await invoke("events.list")).toEqual([]);
        expect(model.prompts).toHaveLength(0);
      }
      const grid = await probe.dom('[data-testid="calendar-week"]');
      const panel = await probe.dom('[data-testid="calendar-event-panel"]');
      expect([1280, 1440]).toContain(grid.viewportWidth);
      expect(panel.elements).toHaveLength(1);
      expect(panel.elements[0]!.tag).toBe("aside");
      expect(grid.elements[0]!.rect.right).toBeLessThanOrEqual(panel.elements[0]!.rect.left);
      expect(panel.elements[0]!.rect.right).toBeLessThanOrEqual(grid.viewportWidth);
      expect((await probe.dom('[data-testid="coworker-calendar"] [role="dialog"], [data-testid="coworker-calendar"] [aria-modal="true"]')).elements).toHaveLength(0);
      await user.screenshot();
      await user.click({ role: "button", text: "Choose references" });
      await user.click({ role: "button", text: "Attach Launch notes (scout)" });
      await user.click({ role: "button", text: "Create event" });
      await user.see({ testId: "event-detail" }, { text: /All Hands/ });
      const events = records(await invoke("events.list"));
      expect(events).toHaveLength(1);
      const event = object(events[0]);
      expect(event).toMatchObject({ id: expect.stringMatching(/^event_/), groupId: expect.stringMatching(/^grp_/), template: "all-hands", leadSlug: "editor", participantSlugs: ["editor", "scout"], artifacts: [expect.objectContaining({ owner: expect.objectContaining({ kind: "coworker", slug: "scout" }), documentId: "launch-notes", revision: 1 })] });
      expect(event).toMatchObject({ startsAt: future.getTime(), schedule: { kind: "once", at: future.getTime() } });
      evidence.recordAssertionEvidence("Participant chips edit an unsaved roster", "Removing Editor cleared Owner. Mixed-case ED plus Enter added Editor without saving; sc exposed Scout but excluded selected Editor. Clicking Scout and rechoosing Editor as owner saved exactly the Editor/Scout roster.", true);
      expect(future.getTime()).toBeGreaterThan(Date.now() + 3_600_000);
      eventId = String(event.id); groupId = String(event.groupId);
      expect((await detail()).runs).toEqual([]);
      expect(model.prompts).toHaveLength(0);
      await user.click({ role: "button", text: "Month" });
      await user.click({ label: "Close event" });
      await user.notSee({ testId: "calendar-event-panel" });
      await user.see({ testId: "calendar-month" });
      await user.screenshot();
      await user.click({ testId: "calendar-item", label: /All Hands.*Scheduled/s });
      await user.see({ testId: "event-detail" }, { text: /All Hands/ });
      evidence.recordAssertionEvidence("Calendar draft is nonmodal and unsaved until creation", "Scout's 14px calendar shortcut opened Scout-only Calendar without selecting Scout's chat. Calendar replaced the Chat rail below its sole mode switch; no calendar filter sidebar remained in the main view. A source-filter roundtrip preserved Calendar preferences and Editor's Chat selection/search. After restoring Everyone, an empty future Month cell opened a prefilled right-sidebar draft. Day and Week stayed usable without losing the draft, saving an event or starting inference. Create event saved exactly one event at the clicked future time with Scout's document reference; the closed Month remained usable.", true);
    });
    await step("Run now gathers both participants and the admitted lead records a structured native outcome", async () => {
      await user.click({ testId: "event-run-now" });
      await expect.poll(async () => {
        expect(model.errors).toEqual([]);
        const runs = (await detail()).runs;
        return runs.length === 1 && ["succeeded", "partial", "failed", "cancelled"].includes(String(runs[0]?.status)) ? runs : null;
      }, { timeout: 180_000, interval: 1_000 }).not.toBeNull();
      const { runs } = await detail();
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: "manual", status: "succeeded", phase: "finished", contributorSlugs: ["editor", "scout"], outcome: eventOutcome, error: "" });
      runId = String(runs[0]?.id);
      expect(model.calls).toEqual([{ id: "event-conclusion", name: "coworker_event_conclude", args: { outcome: eventOutcome } }]);
      expect(model.receipts).toHaveLength(1);
      expect(JSON.parse(model.receipts[0]!.output)).toMatchObject({ recorded: true });
      const routed = [...new Set(model.requests.filter((request) => request.phase).map((request) => `${request.speaker}/${request.phase}/${request.model}`))];
      expect(routed).toEqual(["Editor/contributions/conversation", "Scout/contributions/team", "Editor/conclusion/conversation"]);
      expect(model.requests.some((request) => request.facilitator)).toBe(false);
      evidence.recordAssertionEvidence("Event replies honor shared and personal Conversation models", `Actual native request body.model values: ${routed.join(", ")}. Editor inherited the UI-saved Conversation default for contribution and conclusion; Scout retained its fixed personal model. No facilitator inference was requested for the native Event plan.`, true);
      await user.see({ testId: "event-outcome" }, { text: new RegExp(eventOutcome.summary), timeoutMs: 15_000 });
      for (const line of [...eventOutcome.decisions, ...eventOutcome.accomplishments, ...eventOutcome.openQuestions, ...eventOutcome.followUps]) await user.see({ text: line });
      await user.screenshot();
      evidence.recordAssertionEvidence("Native Event conclusion", "Run now completed one native contribution round and one lead conclusion. The engine advertised and executed coworker_event_conclude, returned recorded:true, and the Event displayed all five structured outcome fields.", true);
    });
    await step("Conversation backlinks, the same occurrence and private document ownership survive reload", async () => {
      const before = await detail();
      await user.click({ testId: "event-open-conversation" });
      await user.see({ testId: "group-chat" }, { text: /customer blockers/ });
      await user.see({ testId: "group-chat" }, { text: new RegExp(eventOutcome.summary) });
      const group = object(await invoke("groups.get", { id: groupId }));
      expect(group).toMatchObject({ id: groupId, turns: [expect.objectContaining({ status: "succeeded" }), expect.objectContaining({ status: "succeeded" })] });
      const timeline = records(await invoke("groups.readTimeline", { id: groupId }));
      expect(timeline.filter((item) => item.kind === "coworker").map((item) => item.slug)).toEqual(["editor", "scout", "editor"]);
      await user.click({ testId: "event-conversation-backlink" });
      expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${eventId}"]`)).elements).toHaveLength(1);
      await reloadNativeView(user, probe);
      await user.click({ role: "button", text: "Calendar" });
      await user.see({ testId: "calendar-item", label: /All Hands.*Actual/s });
      await user.click({ testId: "calendar-item", label: /All Hands.*Actual/s });
      await user.see({ testId: "event-outcome" }, { text: new RegExp(eventOutcome.summary) });
      // Observe across two native 15s ticks; never call claim/tick or replay Run now.
      const requests = model.prompts.length;
      const until = Date.now() + 31_000;
      do {
        expect(await detail()).toEqual(before);
        expect(model.prompts).toHaveLength(requests);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } while (Date.now() < until);
      expect((await probe.dom(`[data-testid="event-detail"][data-run-id="${runId}"]`)).elements).toHaveLength(1);
      expect(await invoke("documents.read", { slug: "scout", id: "launch-notes" })).toEqual(world.document);
      expect(await invoke("documents.list", { slug: "editor" })).toEqual([]);
      expect(await invoke("groups.documents.list", { id: groupId })).toEqual([]);
      expect(await invoke("localResponsibilities.list", { slug: "scout" })).toEqual([world.responsibility]);
      await user.click({ testId: "event-artifact-open-revision" });
      await user.see({ testId: "event-artifact-reader" }, { text: /Owner: Scout.*Private owner notes: keep this document with Scout\./s });
      await user.screenshot();
      evidence.recordAssertionEvidence("One occurrence and unchanged owner", "The Event opened its real group transcript and View event returned to the same Event. After reload and two scheduler ticks the same single run and outcome remained, without more model requests. The recorded revision still read from Scout; Scout's document and responsibility were unchanged and neither Editor nor the group received a document copy.", true);
      // Removing the fixture's team must not strand its retained Calendar history.
      for (const slug of ["editor", "scout"]) await invoke("coworkers.delete", { slug });
      await reloadNativeView(user, probe);
      await user.see({ testId: "coworker-calendar" });
      await user.click({ label: "New coworker" });
      await user.see({ testId: "new-coworker" });
      await user.click({ role: "button", text: "Cancel" });
      await user.see({ testId: "coworker-calendar" });
      expect(await invoke("coworkers.list")).toEqual([]);
      expect((await detail()).runs).toEqual(before.runs);
    });
  } catch (error) {
    await diagnoseViewAnimation(world.app, () => user.screenshot()).catch((diagnosticError) => console.warn("View animation diagnostic failed", String(diagnosticError)));
    throw error;
  }
});

test("A conversational weekly Event runs on the native clock and carries delivered questions into its next session", { timeout: 480_000 }, async ({ world, user, probe, step, evidence }) => {
  const { invoke, model } = world;
  let eventId = "";
  const detail = async () => {
    const value = object(await invoke("events.get", { id: eventId }));
    return { event: object(value.event), runs: records(value.runs), continuity: object(value.continuity) };
  };
  const send = async (action: keyof typeof weeklyPrompts, receiptId: string) => {
    expect(weeklyPrompts[action]).not.toMatch(/coworker_|event_[a-z0-9]|run_[a-z0-9]|grp_[a-z0-9]/);
    await user.type({ role: "textbox", label: "Message Editor" }, weeklyPrompts[action], { replace: true });
    await user.click({ label: "Send" });
    await expect.poll(() => {
      expect(model.errors).toEqual([]);
      return model.receipts.some((receipt) => receipt.id === receiptId);
    }, { timeout: 60_000 }).toBe(true);
    await user.see({ text: weeklyReplies[action] }, { timeoutMs: 30_000 });
    await expect.poll(async () => (await probe.dom('[data-testid="coworker-thread-status"][data-state="working"]')).elements.length, { timeout: 15_000 }).toBe(0);
  };
  const completedRuns = async (count: number, timeout: number) => {
    await expect.poll(async () => {
      expect(model.errors).toEqual([]);
      const runs = (await detail()).runs;
      return runs.length === count && runs.every((run) => ["succeeded", "partial", "failed", "cancelled"].includes(String(run.status)));
    }, { timeout, interval: 1_000 }).toBe(true);
    const runs = (await detail()).runs;
    for (const run of runs) expect(run).toMatchObject({ status: "succeeded", phase: "finished", outcomeStatus: "delivered", contributorSlugs: ["editor", "scout"], error: "" });
    return runs;
  };
  try {
    await reloadNativeView(user, probe);
    await clickCoworkerControl(world.app, { label: "Chat" });
    await user.click({ testId: "coworker-rail-row", label: "Editor" });
    await user.see({ role: "textbox", label: "Message Editor" });
    let first: Record<string, unknown> = {};
    let startsAt = 0;
    await step("A natural request creates a weekly Event through native tools and the real scheduler runs its first slot", async () => {
      const beforeRequest = Date.now();
      await send("create", "weekly-created-details");
      const calendar = model.result("weekly-calendar");
      const receipt = model.result("weekly-create");
      eventId = String(object(receipt.event).id);
      const created = object(model.result("weekly-created-details").event);
      expect(receipt).toMatchObject({ action: "create", event: { id: expect.stringMatching(/^event_/) } });
      expect(created.id).toBe(eventId);
      expect(calendar.observedAt).toBeGreaterThanOrEqual(beforeRequest);
      expect(calendar.observedAt).toBeLessThanOrEqual(Date.now());
      expect(created).toMatchObject({ id: expect.stringMatching(/^event_/), title: weeklyReview.title, objective: weeklyReview.goal, description: weeklyReview.workingPrompt, leadSlug: "editor", participantSlugs: ["editor", "scout"], state: "active" });
      startsAt = Number(created.startsAt);
      expect(startsAt - Number(calendar.observedAt)).toBeGreaterThanOrEqual(90_000);
      expect(startsAt - Number(calendar.observedAt)).toBeLessThan(150_000);
      expect(created).toMatchObject({ nextDueAt: startsAt, repeatUntil: startsAt + 14 * 86_400_000, schedule: { kind: "weekly", timezone: "UTC", daysOfWeek: [new Date(startsAt).getUTCDay()], hour: new Date(startsAt).getUTCHours(), minute: new Date(startsAt).getUTCMinutes() } });
      expect(model.calls.slice(0, 2).map((call) => call.name)).toEqual(["coworker_workplace_calendar", "coworker_event_create"]);
      expect((await detail()).runs).toEqual([]);
      // No tick, claim, clock override, or Run now: native scheduling owns this wait.
      first = object((await completedRuns(1, 240_000))[0]);
      expect(["scheduled", "recovery"]).toContain(first.trigger);
      expect(first).toMatchObject({ scheduledFor: startsAt, outcome: weeklyOutcomes[0], continuity: { sourceRunId: null } });
      expect(first.startedAt).toBeGreaterThanOrEqual(startsAt);
      expect((await detail()).event).toMatchObject({ nextDueAt: startsAt + 7 * 86_400_000, repeatUntil: startsAt + 14 * 86_400_000 });
      expect(model.calls.some((call) => call.name === "coworker_event_manage")).toBe(false);
      const saved = await detail();
      const calls = model.calls.slice();
      await reloadNativeView(user, probe);
      await user.see({ role: "textbox", label: "Message Editor" });
      expect(await detail()).toEqual(saved);
      expect(model.calls).toEqual(calls);
      evidence.recordAssertionEvidence("Conversational creation and native weekly occurrence", "The private human request used no tool names or native IDs. The real calendar tool supplied observedAt; create returned the Event ID and weekly UTC schedule with a two-week end. Its first slot completed through the native scheduler without Run now, advanced next due by one week, and survived reload without another claim.", true);
    });
    await step("Private native tools pause and revise future sessions without rewriting the delivered first run", async () => {
      await send("pause", "weekly-pause");
      expect(model.result("weekly-pause")).toMatchObject({ action: "pause", event: { id: eventId, state: "paused", nextDueAt: null } });
      expect((await detail()).runs).toEqual([first]);
      expect(model.result("weekly-pause-details")).toMatchObject({ continuity: { sourceRunId: first.id, openQuestions: weeklyOutcomes[0]!.openQuestions, followUps: weeklyOutcomes[0]!.followUps } });
      await send("update", "weekly-resume");
      expect(model.result("weekly-update")).toMatchObject({ action: "update", event: { state: "paused" } });
      expect(model.result("weekly-resume")).toMatchObject({ action: "resume", event: { state: "active", nextDueAt: startsAt + 7 * 86_400_000 } });
      expect((await detail()).event).toMatchObject({ objective: weeklyReview.revisedGoal, description: weeklyReview.workingPrompt, repeatUntil: startsAt + 14 * 86_400_000 });
      expect((await detail()).runs).toEqual([first]);
      evidence.recordAssertionEvidence("Native pause, full update and resume", "Private Event tools read the current definition before pause and full-input update, and resume used the returned revision. Pausing removed next due; resuming restored next week's slot, retained repeatUntil, and left the delivered first run unchanged.", true);
    });
    await step("A tool-requested second run freezes delivered questions and the current Event shows its new result", async () => {
      await send("run", "weekly-run-now");
      const accepted = object(model.result("weekly-run-now").run);
      expect(accepted.id).not.toBe(first.id);
      const runs = await completedRuns(2, 150_000);
      const second = object(runs.find((run) => run.id === accepted.id));
      expect(second).toMatchObject({ trigger: "manual", event: { objective: weeklyReview.revisedGoal }, outcome: weeklyOutcomes[1], continuity: { sourceRunId: first.id, previousRunId: first.id, previousStatus: "succeeded", summary: weeklyOutcomes[0]!.summary, openQuestions: weeklyOutcomes[0]!.openQuestions, followUps: weeklyOutcomes[0]!.followUps } });
      expect(runs.find((run) => run.id === first.id)).toEqual(first);
      const carried = model.requests.filter((request) => request.phase === "contributions" && request.prompt.includes(`"sourceRunId":"${first.id}"`));
      expect(carried.map((request) => request.speaker)).toEqual(["Editor", "Scout"]);
      for (const text of [String(first.id), ...weeklyOutcomes[0]!.openQuestions, ...weeklyOutcomes[0]!.followUps]) {
        expect(weeklyPrompts.run).not.toContain(text);
        for (const request of carried) expect(request.prompt).toContain(text);
      }
      const conclusions = model.receipts.filter((receipt) => receipt.name === "coworker_event_conclude");
      expect(conclusions).toHaveLength(2);
      expect(new Set(conclusions.map((receipt) => receipt.id)).size).toBe(2);
      for (const receipt of conclusions) expect(JSON.parse(receipt.output)).toMatchObject({ recorded: true });
      expect(model.calls.filter((call) => call.name === "coworker_event_manage").map((call) => call.args.action)).toEqual(["pause", "resume", "run_now"]);
      await user.click({ testId: "group-rail-row", label: weeklyReview.title });
      await user.see({ testId: "group-chat" }, { text: new RegExp(weeklyOutcomes[1]!.summary) });
      await user.click({ testId: "event-conversation-backlink" });
      await user.see({ testId: "event-detail" }, { text: new RegExp(weeklyReview.revisedGoal) });
      await user.see({ testId: "event-latest-outcome" }, { text: new RegExp(weeklyOutcomes[1]!.summary) });
      const latest = await probe.dom(`[data-testid="event-latest-outcome"][data-source-run-id="${second.id}"]`);
      expect(latest.elements).toHaveLength(1);
      expect(latest.elements[0]!.text).toContain(weeklyOutcomes[1]!.openQuestions[0]);
      expect(latest.elements[0]!.text).not.toContain(weeklyOutcomes[0]!.openQuestions[0]);
      await user.screenshot();
      evidence.recordAssertionEvidence("Delivered continuity reaches the next native prompt", "The second run was requested through the native manage tool. Both real contribution requests carried the first run ID, pending questions and follow-ups although the human's Run another session now message contained none of them. The second delivered outcome resolved one question, the first run stayed immutable, and the current Event definition showed the second summary and remaining question without selecting history.", true);
    });
  } catch (error) {
    await diagnoseViewAnimation(world.app, () => user.screenshot()).catch((diagnosticError) => console.warn("View animation diagnostic failed", String(diagnosticError)));
    throw error;
  }
});

test("Activity opens native private and Event mentions without losing another discussion's draft", { timeout: 300_000 }, async ({ world, user, probe, step, evidence }) => {
  const { invoke, model } = world;
  const items = async () => records(await invoke("activity.list"));
  const notification = async (preview: string) => {
    const matches = (await items()).filter((item) => item.preview === preview);
    expect(matches).toHaveLength(1);
    return object(matches[0]);
  };
  const editor = async () => object(await invoke("coworkers.get", { slug: "editor" }));
  const completion = async (threadId: string) => object(records(await invoke("turns.activity", { slug: "editor", threadId }))[0]);
  const send = async (action: keyof typeof activityReplies) => {
    await user.type({ role: "textbox", label: "Message Editor" }, activityPrompts[action], { replace: true });
    await user.click({ label: "Send" });
    await expect.poll(() => {
      expect(model.errors).toEqual([]);
      return model.requests.filter((request) => request.activityAction === action).length;
    }, { timeout: 60_000 }).toBe(1);
    await user.see({ testId: "coworker-reply-bubble", label: activityReplies[action] }, { timeoutMs: 30_000 });
    const threadId = String((await editor()).conversationThreadId);
    await expect.poll(() => completion(threadId), { timeout: 30_000 }).toMatchObject({ threadId, state: "succeeded", available: true });
    return threadId;
  };
  const privateRow = { role: "button", label: /^Open conversation\..*which launch question/s } satisfies Parameters<User["click"]>[0];
  const eventRow = { role: "button", label: /^Open conversation\..*Event · Launch decision check-in.*please choose the next launch follow-up/s } satisfies Parameters<User["click"]>[0];
  const startsAt = Date.now() + 9 * 60_000;
  const event = object(await invoke("events.create", { input: { ...activityEvent, description: "Compare notes without external action.", template: "working-session", leadSlug: "editor", participantSlugs: ["editor", "scout"], startsAt, schedule: { kind: "once", at: startsAt, timezone: "UTC" }, durationMinutes: 5, maxReplies: 3, state: "active", artifacts: [] } }));
  const eventDate = new Date(Number(event.startsAt));
  const dateKey = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, "0")}-${String(eventDate.getDate()).padStart(2, "0")}`;
  const reminderRow = { role: "button", label: /^Open event\..*Launch decision check-in.*Event reminder/s } satisfies Parameters<User["click"]>[0];
  const upcomingRow = { role: "button", label: /^View event in Calendar\..*Launch decision check-in.*Owner: Editor/s } satisfies Parameters<User["click"]>[0];
  const reminder = async () => {
    const matches = (await items()).filter((item) => item.kind === "event-reminder" && object(item.target).eventId === event.id && object(item.target).scheduledFor === startsAt);
    expect(matches).toHaveLength(1);
    return object(matches[0]);
  };
  let originalThread = "", draftThread = "";
  let firstExecution: Record<string, unknown> = {};

  await reloadNativeView(user, probe);
  await step("A completed private mention appears natively; filtering and read controls leave the other draft unsent", async () => {
    await user.click({ label: "Chat" });
    await user.click({ testId: "coworker-rail-row", label: "Editor" });
    originalThread = await send("mention");
    expect(originalThread).toMatch(/^ses_/);
    firstExecution = await completion(originalThread);
    const owner = await editor();
    await expect.poll(items, { timeout: 30_000 }).toContainEqual(expect.objectContaining({ id: `activity_${firstExecution.executionId}`, kind: "mention", slug: "editor", workspaceId: owner.workspaceId, coworkerCreatedAt: owner.createdAt, preview: activityReplies.mention, readAt: null, target: { kind: "private", threadId: originalThread } }));
    await user.click({ testId: "coworker-discussion-switcher" });
    await user.click({ testId: "coworker-new-discussion" });
    await user.see({ testId: "coworker-discussion-empty" });
    await expect.poll(async () => (await editor()).conversationThreadId, { timeout: 15_000 }).not.toBe(originalThread);
    draftThread = String((await editor()).conversationThreadId);
    expect(draftThread).toMatch(/^ses_/);
    await user.type({ label: "Message Editor" }, activityPrompts.draft);
    await user.click({ testId: "coworker-activity-button" });
    await user.click({ role: "button", label: /^Mentions\b/ });
    await user.see(privateRow, { timeoutMs: 15_000 });
    const unread = await notification(activityReplies.mention);
    expect(unread.readAt).toBeNull();
    await user.screenshot();
    await user.click({ label: "Mark as read: Editor, Private chat" });
    await expect.poll(async () => (await notification(activityReplies.mention)).readAt, { timeout: 10_000 }).toEqual(expect.any(Number));
    await user.click({ testId: "activity-unread-filter" });
    await user.notSee(privateRow);
    await user.click({ testId: "activity-unread-filter" });
    await user.click({ role: "button", label: /^All\b/ });
    await user.click({ label: "Mark as unread: Editor, Private chat" });
    await expect.poll(() => notification(activityReplies.mention), { timeout: 10_000 }).toEqual(unread);
    await user.click({ testId: "activity-unread-filter" });
    await user.see(privateRow);
    await user.click({ role: "button", label: "Go to coworker" });
    await user.see({ label: "Message Editor" }, { value: activityPrompts.draft, editable: true });
    await user.click({ label: "Calendar" });
    await user.see({ testId: "coworker-calendar" });
    await user.click({ label: "Chat" });
    await user.see({ label: "Message Editor" }, { value: activityPrompts.draft, editable: true });
    expect((await editor()).conversationThreadId).toBe(draftThread);
  });
  await step("Opening the private mention restores its native discussion and sends exactly one reply there", async () => {
    await user.click({ testId: "coworker-activity-button" });
    await user.click(privateRow);
    await user.see({ testId: "coworker-reply-bubble" }, { text: activityReplies.mention });
    await user.see({ label: "Message Editor" }, { value: "", editable: true });
    await expect.poll(async () => (await editor()).conversationThreadId, { timeout: 15_000 }).toBe(originalThread);
    await expect.poll(async () => (await notification(activityReplies.mention)).readAt, { timeout: 10_000 }).toEqual(expect.any(Number));
    expect(await send("reply")).toBe(originalThread);
    const replied = await completion(originalThread);
    expect(replied).toMatchObject({ threadId: originalThread, slug: "editor", replies: [expect.objectContaining({ parentId: replied.messageId, parts: [expect.objectContaining({ text: activityReplies.reply })] })] });
    expect(replied.messageId).not.toBe(firstExecution.messageId);
    await expect.poll(items, { timeout: 30_000 }).toContainEqual(expect.objectContaining({ id: `activity_${replied.executionId}`, kind: "reply", preview: activityReplies.reply, readAt: null, target: { kind: "private", threadId: originalThread } }));
    expect(model.requests.filter((request) => request.activityAction === "reply")).toHaveLength(1);
    await user.click({ testId: "coworker-discussion-switcher" });
    await user.see({ testId: "coworker-discussion-menu" });
    const draftLabel = await probe.eval(browserScript((threadId) => document.querySelector<HTMLElement>(`[data-testid="coworker-discussion-menu"] [data-thread-id="${threadId}"]`)?.innerText.trim() ?? "", [draftThread]));
    expect(draftLabel).not.toBe("");
    await user.click({ label: draftLabel });
    await user.see({ label: "Message Editor" }, { value: activityPrompts.draft, editable: true });
    expect((await editor()).conversationThreadId).toBe(draftThread);
    expect(await invoke("turns.activity", { slug: "editor", threadId: draftThread })).toEqual([]);
    evidence.recordAssertionEvidence("Private Activity preserves native thread and draft ownership", "A real completed private reply became an identity-matched mention without seeding Activity. UI read/unread controls changed only readAt; Activity/back and Calendar/Chat kept the second draft. Opening the mention restored the original editable discussion, and one loopback request produced a new native message there, not in the draft discussion.", true);
  });
  await step("A native reminder opens its scheduled Event without acknowledgement and keeps Calendar and Activity context", async () => {
    await expect.poll(items, { timeout: 30_000, interval: 1_000 }).toContainEqual(expect.objectContaining({ kind: "event-reminder", title: activityEvent.title, readAt: null, target: { kind: "event", eventId: event.id, groupId: event.groupId, scheduledFor: startsAt } }));
    const unreadReminder = await reminder();
    const otherNotifications = (await items()).filter((item) => item.id !== unreadReminder.id);
    await user.click({ label: "Calendar" });
    await user.click({ role: "button", text: "Day" });
    await user.click({ label: "Next day" });
    await user.click({ role: "checkbox", label: "Events" });
    const preferences = await probe.storage("coworker.calendar.preferences.v1");
    expect(preferences).toMatchObject({ view: "day", events: false });
    await user.click({ testId: "coworker-activity-button" });
    expect((await probe.dom('[data-testid="activity-unread-filter"][aria-pressed="true"]')).elements).toHaveLength(1);
    await user.see({ testId: "event-reminder" }, { text: new RegExp(activityEvent.title), timeoutMs: 15_000 });
    await user.click({ role: "button", label: /^Up next/ });
    await user.see({ testId: "activity-upcoming-events" }, { text: /Up next.*Launch decision check-in/s });
    await user.see(upcomingRow);
    expect((await probe.dom(`[data-testid="activity-upcoming-events"] time[datetime="${eventDate.toISOString()}"]`)).elements).toHaveLength(1);
    await user.screenshot();
    await user.click(reminderRow);
    await user.see({ testId: "event-detail" }, { text: new RegExp(activityEvent.title) });
    expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${event.id}"][data-run-id=""]`)).elements).toHaveLength(1);
    await user.see({ label: "Go to date" }, { value: dateKey });
    await user.see({ text: "This event is hidden by the Events source filter. Your filters are unchanged." });
    expect(await probe.storage("coworker.calendar.preferences.v1")).toEqual(preferences);
    expect(await reminder()).toEqual(unreadReminder);
    await user.click({ role: "button", label: "Mark reminder as read" });
    await expect.poll(async () => (await reminder()).readAt, { timeout: 10_000 }).toEqual(expect.any(Number));
    await user.see({ text: "Reminder marked as read." });
    expect((await items()).filter((item) => item.id !== unreadReminder.id)).toEqual(otherNotifications);
    await user.screenshot();
    await user.see({ testId: "activity-inbox" });
    expect((await probe.dom('[data-testid="activity-unread-filter"][aria-pressed="true"]')).elements).toHaveLength(1);
    await user.notSee({ testId: "event-reminder" });
    await user.click(upcomingRow);
    await user.see({ testId: "event-detail" }, { text: new RegExp(activityEvent.title) });
    await user.notSee({ role: "button", label: "Mark reminder as read" });
    await user.click({ testId: "coworker-activity-button" });
    await user.click({ testId: "coworker-activity-button" });
    await user.click({ role: "button", label: "Go to calendar" });
    await user.see({ label: "Go to date" }, { value: dateKey });
    expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${event.id}"][data-run-id=""]`)).elements).toHaveLength(1);
    expect(await probe.storage("coworker.calendar.preferences.v1")).toEqual(preferences);
    expect(records(object(await invoke("events.get", { id: event.id })).runs)).toEqual([]);
    evidence.recordAssertionEvidence("Native reminder and context-aware Calendar return", "The real scheduler produced one reminder for the Event's upcoming slot. Activity showed it beside Up next despite Calendar's hidden Events filter. Opening it selected the exact Event and scheduled date without reading it; only Mark reminder as read acknowledged it, leaving other notifications untouched. Inline Activity retained Unread, and Up next plus repeated bell clicks retained Calendar's date, Event and filters without starting a run.", true);
  });
  await step("An Activity destination waits for the unsaved Calendar draft and opens only on explicit request", async () => {
    const before = await invoke("events.list");
    const prompts = model.prompts.length;
    const unsavedTitle = "Keep this event draft unsaved";
    await user.click({ testId: "coworker-activity-button" });
    await user.click({ role: "button", label: "New event" });
    await user.see({ testId: "event-editor" });
    await user.type({ label: /^Title$/i }, unsavedTitle, { replace: true });
    await user.see({ testId: "activity-inbox" });
    await user.click(upcomingRow);
    await user.see({ label: /^Title$/i }, { value: unsavedTitle, editable: true });
    await user.see({ text: "Your requested destination is kept until you save or cancel this draft." });
    await user.see({ role: "button", label: "Open requested event" });
    expect((await probe.dom('[data-testid="coworker-calendar"] button:disabled')).elements).toContainEqual(expect.objectContaining({ text: "Open requested event" }));
    await user.notSee({ testId: "event-detail" });
    expect(await invoke("events.list")).toEqual(before);
    await user.click({ role: "button", label: /^Cancel$/ });
    await user.notSee({ testId: "event-editor" });
    await user.notSee({ testId: "event-detail" });
    await user.see({ text: "Your requested destination is ready to open." });
    expect((await probe.dom('[data-testid="coworker-calendar"] button:not(:disabled)')).elements).toContainEqual(expect.objectContaining({ text: "Open requested event" }));
    await user.click({ role: "button", label: "Open requested event" });
    await user.see({ testId: "event-detail" }, { text: new RegExp(activityEvent.title) });
    expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${event.id}"][data-run-id=""]`)).elements).toHaveLength(1);
    await user.see({ label: "Go to date" }, { value: dateKey });
    expect(await invoke("events.list")).toEqual(before);
    expect(records(object(await invoke("events.get", { id: event.id })).runs)).toEqual([]);
    expect(model.prompts).toHaveLength(prompts);
    await user.click({ role: "button", label: "Go to calendar" });
    await user.click({ role: "checkbox", label: "Events" });
    await user.click({ label: "Chat" });
    evidence.recordAssertionEvidence("Calendar draft blocks but retains the requested destination", "New event from Activity kept the typed unsaved title through Activity and an Up next open request. The requested destination was disabled while the draft remained; Cancel neither saved nor opened an Event. Only Open requested event selected the original Event and date. The native Event list and model request count stayed unchanged, with no runs.", true);
  });
  await step("Run now publishes a real Event mention whose exact source is revealed before acknowledgement", async () => {
    await user.click({ testId: "group-rail-row", label: activityEvent.title });
    await user.click({ testId: "event-conversation-backlink" });
    await user.click({ testId: "event-run-now" });
    await expect.poll(async () => {
      expect(model.errors).toEqual([]);
      return records(object(await invoke("events.get", { id: event.id })).runs);
    }, { timeout: 150_000, interval: 1_000 }).toEqual([expect.objectContaining({ status: "succeeded", outcome: activityOutcome })]);
    expect(model.result("activity-conclusion")).toMatchObject({ recorded: true });
    const run = object(records(object(await invoke("events.get", { id: event.id })).runs)[0]);
    const source = object(records(await invoke("groups.readTimeline", { id: event.groupId })).find((entry) => entry.kind === "coworker" && entry.text === activityOutcome.summary));
    expect(source).toMatchObject({ slug: "editor", executionId: expect.any(String), threadId: expect.stringMatching(/^ses_/) });
    await expect.poll(items, { timeout: 30_000 }).toContainEqual(expect.objectContaining({ id: `activity_${source.executionId}`, kind: "mention", slug: "editor", preview: activityOutcome.summary, readAt: null, target: expect.objectContaining({ kind: "group", groupId: event.groupId, eventId: source.id, workplaceEventId: event.id, runId: run.id, scheduledFor: run.scheduledFor }) }));
    const otherNotifications = (await items()).filter((item) => item.preview !== activityOutcome.summary);
    await user.click({ testId: "coworker-activity-button" });
    await user.click({ role: "button", label: /^Mentions\b/ });
    await user.see(eventRow, { timeoutMs: 15_000 });
    await user.notSee({ role: "button", label: /^Open conversation\..*The launch decision stays/s });
    expect((await notification(activityOutcome.summary)).readAt).toBeNull();
    await user.click({ label: `View session: ${activityEvent.title}` });
    await expect.poll(async () => (await probe.dom(`[data-testid="event-session-row"][data-run-id="${run.id}"][aria-pressed="true"]`)).elements, { timeout: 15_000 }).toHaveLength(1);
    expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${event.id}"][data-run-id="${run.id}"]`)).elements).toHaveLength(1);
    const runDate = new Date(Number(run.scheduledFor));
    const runDateKey = `${runDate.getFullYear()}-${String(runDate.getMonth() + 1).padStart(2, "0")}-${String(runDate.getDate()).padStart(2, "0")}`;
    await user.see({ label: "Go to date" }, { value: runDateKey });
    await user.click({ testId: "event-open-conversation" });
    await user.see({ testId: "group-chat" }, { text: new RegExp(activityOutcome.summary) });
    await user.click({ testId: "event-conversation-backlink" });
    await expect.poll(async () => (await probe.dom(`[data-testid="event-session-row"][data-run-id="${run.id}"][aria-pressed="true"]`)).elements, { timeout: 15_000 }).toHaveLength(1);
    expect((await probe.dom(`[data-testid="event-detail"][data-event-id="${event.id}"][data-run-id="${run.id}"]`)).elements).toHaveLength(1);
    await user.see({ label: "Go to date" }, { value: runDateKey });
    expect((await notification(activityOutcome.summary)).readAt).toBeNull();
    await user.see({ testId: "activity-inbox" });
    expect((await probe.dom('[data-testid="activity-inbox"] [aria-label="Filter activity"] [aria-pressed="true"]')).elements).toEqual([expect.objectContaining({ text: expect.stringMatching(/^Mentions\b/) })]);
    await user.click(eventRow);
    await user.see({ testId: "group-chat" }, { text: /@you, please choose the next launch follow-up from this check-in\./ });
    await expect.poll(async () => (await probe.dom(`[data-testid="group-chat"] [data-event-id="${source.id}"]:focus`)).elements, { timeout: 15_000 }).toEqual([expect.objectContaining({ text: expect.stringContaining(activityOutcome.summary) })]);
    await expect.poll(async () => (await notification(activityOutcome.summary)).readAt, { timeout: 10_000 }).toEqual(expect.any(Number));
    expect((await items()).filter((item) => item.preview !== activityOutcome.summary)).toEqual(otherNotifications);
    await user.screenshot();
    await user.click({ role: "button", label: "Go to chat" });
    await user.click({ testId: "coworker-rail-row", label: "Editor" });
    await user.see({ label: "Message Editor" }, { value: activityPrompts.draft, editable: true });
    expect((await editor()).conversationThreadId).toBe(draftThread);
    expect(await invoke("turns.activity", { slug: "editor", threadId: draftThread })).toEqual([]);
    expect(model.prompts.some((prompt) => prompt.includes(activityPrompts.draft))).toBe(false);
    expect(model.errors).toEqual([]);
    evidence.recordAssertionEvidence("Event Activity opens the published source, not just its group", "Run now completed the seeded definition through native contribution and conclusion tools. Its mention targeted the exact published timeline event/execution and accepted Event session. View session selected that run and date; conversation/backlink retained the selected session without acknowledging the mention. Inline Activity retained Mentions; clicking the notification focused that data-event-id before the read acknowledgement was observed, without changing other notifications or sending the other discussion's retained draft.", true);
  });
});
