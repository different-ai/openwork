import { browserScript, coworker, evalIn, spec, type Probe, type User } from "@openwork/testkit";
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { allHandsModel, eventOutcome, weeklyOutcomes, weeklyPrompts, weeklyReplies, weeklyReview } from "../packages/labs/src/mock-all-hands-model.ts";
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
    await invoke("settings.update", { automaticMemoryEnabled: false });
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
