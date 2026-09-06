import {
  control,
  createNativeConnector,
  createOrgConnection,
  denFetch,
  evalIn,
  listSessions,
  readComposerState,
  renameSessionAndWait,
  signInDesktopAs,
  waitUntilInteractive,
} from "@openwork/behaviors";
import {
  callFunctionOnSurface,
  clickAt,
  dumpScreenState,
  evaluateOnSurface,
  hoverAt,
  locate,
  assertAbsent,
  navigate,
  pressKey,
  reload,
  setViewport,
  typeText,
  waitForLocated,
} from "@openwork/cdp";
import type { Located, Surface, Target } from "@openwork/cdp";
import {
  app as startApp,
  faultProxy as startFaultProxy,
  mcpMock,
  server,
} from "@openwork/env";
import type { Den, Place } from "@openwork/env";
import { chrome, desktop } from "@openwork/hosts";
import { expectVisualEvidence } from "@openwork/test-evidence/vitest";
import { screenshot, validate } from "@openwork/test-evidence";
import type {
  StepRecord,
  StepRecordInput,
  TestEvidenceRecorder,
  TestOutcome,
  TraceChannel,
  TraceEntry,
  TraceEntryInput,
} from "@openwork/test-evidence";
import { eventually } from "../eventually.ts";
import { denLink as startDenLink } from "../link.ts";
import { readConnectState } from "../state.ts";
import type {
  Agent,
  ClickOptions,
  Probe,
  ProbeEvalOptions,
  Seed,
  SeedDesktopOptions,
  SeedWebOptions,
  SeeOptions,
  SpecAdapters,
  Step,
  TypeOptions,
  User,
} from "./types.ts";

interface EvidenceSink {
  recordTrace(entry: TraceEntryInput): TraceEntry;
  recordStep(step: StepRecordInput): StepRecord;
  setOutcome(outcome: TestOutcome, failure?: string): void;
}

export class BufferedEvidenceSink implements EvidenceSink {
  readonly trace: TraceEntry[] = [];
  readonly steps: StepRecord[] = [];
  outcome: TestOutcome = "unknown";
  failure?: string;

  recordTrace(entry: TraceEntryInput): TraceEntry {
    const recorded: TraceEntry = {
      ...entry,
      seq: this.trace.length + 1,
      at: entry.at ?? new Date().toISOString(),
    };
    this.trace.push(recorded);
    return recorded;
  }

  recordStep(step: StepRecordInput): StepRecord {
    const recorded: StepRecord = { ...step, seq: this.steps.length + 1 };
    this.steps.push(recorded);
    return recorded;
  }

  setOutcome(outcome: TestOutcome, failure?: string): void {
    this.outcome = outcome;
    this.failure = failure;
  }
}

export function replayEvidence(buffer: BufferedEvidenceSink, evidence: TestEvidenceRecorder): void {
  for (const entry of buffer.trace) {
    const { seq, ...input } = entry;
    void seq;
    evidence.recordTrace(input);
  }
  for (const step of buffer.steps) {
    const { seq, ...input } = step;
    void seq;
    evidence.recordStep(input);
  }
  if (buffer.outcome !== "unknown") evidence.setOutcome(buffer.outcome, buffer.failure);
}

export class SeedBeforeActError extends Error {
  constructor(verb: string) {
    super(`seed.${verb}() before the first act — move it into the world function`);
    this.name = "SeedBeforeActError";
  }
}

class StepNotReachedError extends Error {
  constructor(name: string) {
    super(`Step ${JSON.stringify(name)} was not reached because an earlier step failed.`);
    this.name = "StepNotReachedError";
  }
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redacted(value: string): string {
  return value
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer <redacted>")
    .replace(/((?:["']?[\w.-]*(?:token|secret|password)[\w.-]*["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}&]+)/gi, "$1<redacted>")
    .slice(0, 240);
}

function isSurface(value: unknown): value is Surface {
  if (typeof value !== "object" || value === null) return false;
  return "handle" in value && "client" in value;
}

function isAsyncDisposable(value: unknown): value is AsyncDisposable {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, Symbol.asyncDispose) === "function";
}

export function primarySurface(value: unknown): Surface | null {
  if (isSurface(value)) return value;
  if (typeof value !== "object" || value === null) return null;
  const app = Reflect.get(value, "app");
  if (isSurface(app)) return app;
  const web = Reflect.get(value, "web");
  if (isSurface(web)) return web;
  const surfaces = Object.values(value).filter(isSurface);
  return surfaces.length === 1 ? surfaces[0] : null;
}

function surfaceName(surface: Surface | null): string | undefined {
  return surface?.handle.name;
}

function targetDetail(target: Target): string {
  if (typeof target === "string") return target;
  if (target.testId) return `testId=${target.testId}`;
  if (target.label) return `label=${matcherDetail(target.label)}`;
  if (target.text) return `text=${matcherDetail(target.text)}`;
  if (target.placeholder) return `placeholder=${target.placeholder}`;
  return target.role ?? "target";
}

function matcherDetail(value: string | RegExp): string {
  return typeof value === "string" ? value : `/${value.source}/${value.flags}`;
}

function optionTextDetail(value: string | RegExp): string {
  return typeof value === "string" ? JSON.stringify(redacted(value)) : matcherDetail(value);
}

function seeDetail(target: Target, options: SeeOptions): string {
  const details = [targetDetail(target)];
  if (options.editable !== undefined) details.push(options.editable ? "editable" : "editable=false");
  if (options.value !== undefined) details.push(`value=${JSON.stringify(redacted(options.value))}`);
  if (options.text !== undefined) details.push(`text=${optionTextDetail(options.text)}`);
  if (options.timeoutMs !== undefined) details.push(`timeoutMs=${options.timeoutMs}`);
  return `see(${details.join(", ")})`;
}

function textMatches(actual: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return actual.trim() === expected.trim();
  return new RegExp(expected.source, expected.flags).test(actual);
}

function typedTextDetail(target: Target, text: string, options: TypeOptions): string {
  const targetName = targetDetail(target);
  const sensitive = /password|token|secret/i.test(targetName);
  return `type(${targetName}, ${sensitive ? "<redacted>" : JSON.stringify(redacted(text))}${options.replace ? ", replace" : ""})`;
}

const CONTROL_READY_TIMEOUT_MS = 60_000;
const CONTROL_POLL_INTERVAL_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitForControlAction(surface: Surface, action: string, timeoutMs = CONTROL_READY_TIMEOUT_MS): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastError: unknown = null;
  await waitForControlRail(surface, action, Math.max(1, deadline - Date.now()));
  while (Date.now() < deadline) {
    try {
      const actions = await evalIn(surface, "window.__openworkControl?.listActions?.() ?? null", {
        timeoutMs: Math.min(2_000, Math.max(1, deadline - Date.now())),
      });
      if (Array.isArray(actions) && actions.some((entry) => isRecord(entry) && entry.id === action && entry.disabled !== true)) return;
      lastError = new Error(`action ${action} is not enabled`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(CONTROL_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`control rail not ready for ${action} within ${timeoutMs}ms${lastError ? `: ${messageText(lastError)}` : ""}`);
}

async function waitForControlRail(surface: Surface, action: string, timeoutMs = CONTROL_READY_TIMEOUT_MS): Promise<void> {
  try {
    await waitUntilInteractive(surface, { timeoutMs });
  } catch (error) {
    throw new Error(`control rail not ready for ${action} within ${timeoutMs}ms: ${messageText(error)}`);
  }
}

async function createSessionWhenReady(surface: Surface): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForControlAction(surface, "session.create_task");
    try {
      const result = await control(surface, "session.create_task");
      if (typeof result === "string" && result.trim()) return result.trim();
      if (attempt === 1) throw new Error("session.create_task returned no session ID after one retry.");
    } catch (error) {
      const emptyResult = /did not return a session ID|returned no session ID|invalid session ID/i.test(messageText(error));
      if (attempt === 1 || !emptyResult) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_INTERVAL_MS));
  }
  throw new Error("session.create_task returned no session ID after one retry.");
}

export class SpecRuntime {
  stage: "world" | "body" = "world";
  acted = false;
  primary: Surface | null = null;
  sink: EvidenceSink;
  readonly stack: AsyncDisposableStack;
  readonly place: Place;
  readonly adapters: SpecAdapters;
  #stepDepth = 0;
  #stepBlocked = false;

  constructor(place: Place, stack: AsyncDisposableStack, sink: EvidenceSink, adapters: SpecAdapters = {}) {
    this.place = place;
    this.stack = stack;
    this.sink = sink;
    this.adapters = adapters;
  }

  useSink(sink: EvidenceSink): void {
    this.sink = sink;
  }

  setPrimary(value: unknown): void {
    this.primary = primarySurface(value);
  }

  emit(entry: TraceEntryInput): TraceEntry {
    const recorded = this.sink.recordTrace(entry);
    this.adapters.observe?.trace?.(recorded);
    return recorded;
  }

  setOutcome(outcome: TestOutcome, failure?: string): void {
    const safeFailure = failure === undefined ? undefined : redacted(failure);
    this.sink.setOutcome(outcome, safeFailure);
    this.adapters.observe?.outcome?.(outcome, safeFailure);
  }

  checkOrder(channel: TraceChannel, verb: string): void {
    if (channel === "user" || channel === "agent") this.acted = true;
    if ((channel === "seed" || channel === "seed:raw") && this.stage === "body" && !this.acted) {
      throw new SeedBeforeActError(verb);
    }
  }

  async call<T>(channel: TraceChannel, verb: string, detail: string, surface: Surface | null, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const safeDetail = redacted(detail);
    try {
      this.checkOrder(channel, verb);
      const result = await fn();
      this.emit({
        stage: this.stage,
        channel,
        verb,
        detail: safeDetail,
        surface: surfaceName(surface),
        ok: true,
        ms: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.emit({
        stage: this.stage,
        channel,
        verb,
        detail: safeDetail,
        surface: surfaceName(surface),
        ok: false,
        ms: Date.now() - startedAt,
        error: redacted(messageText(error)),
      });
      throw error;
    }
  }

  sync<T>(channel: TraceChannel, verb: string, detail: string, fn: () => T): T {
    const startedAt = Date.now();
    try {
      this.checkOrder(channel, verb);
      const result = fn();
      this.emit({ stage: this.stage, channel, verb, detail: redacted(detail), ok: true, ms: Date.now() - startedAt });
      return result;
    } catch (error) {
      this.emit({
        stage: this.stage,
        channel,
        verb,
        detail: redacted(detail),
        ok: false,
        ms: Date.now() - startedAt,
        error: redacted(messageText(error)),
      });
      throw error;
    }
  }

  failWorld(error: unknown): void {
    this.emit({
      stage: "world",
      channel: "seed",
      verb: "build",
      detail: "world build",
      ok: false,
      error: redacted(messageText(error)),
    });
    this.setOutcome("failed", messageText(error));
  }

  step: Step = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    if (this.#stepBlocked) {
      const step = this.sink.recordStep({ name, depth: this.#stepDepth, ok: "not-reached" });
      this.adapters.observe?.step?.(step);
      this.emit({ stage: "body", channel: "step", verb: "step", detail: name, ok: false, error: "not-reached" });
      throw new StepNotReachedError(name);
    }
    const depth = this.#stepDepth;
    this.#stepDepth += 1;
    const startedAt = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - startedAt;
      const step = this.sink.recordStep({ name, depth, ok: true, ms });
      this.adapters.observe?.step?.(step);
      this.emit({ stage: "body", channel: "step", verb: "step", detail: name, ok: true, ms });
      return result;
    } catch (error) {
      const ms = Date.now() - startedAt;
      const failure = redacted(messageText(error));
      const step = this.sink.recordStep({ name, depth, ok: false, ms, error: failure });
      this.adapters.observe?.step?.(step);
      this.emit({ stage: "body", channel: "step", verb: "step", detail: name, ok: false, ms, error: failure });
      this.#stepBlocked = true;
      this.setOutcome("failed", failure);
      throw error;
    } finally {
      this.#stepDepth -= 1;
    }
  };
}

function requireSurface(surface: Surface | null): Surface {
  if (!surface) throw new Error("This world has no primary surface; bind one with user.on(surface), agent.on(surface), or probe.on(surface).");
  return surface;
}

function sessionFromWebOptions(options: SeedWebOptions) {
  const identity = options.signedInAs;
  if (typeof identity === "object" && identity !== null) return identity;
  if (identity === undefined || identity === "admin") return options.den.admin;
  const member = options.den.members[identity];
  if (!member) throw new Error(`Unknown Den member ${JSON.stringify(identity)}.`);
  return member;
}

export class SeedChannel implements Seed {
  readonly #runtime: SpecRuntime;

  constructor(runtime: SpecRuntime) {
    this.#runtime = runtime;
  }

  den(options: Omit<import("@openwork/env").ServerOptions, "place"> = {}): Promise<Den> {
    return this.#runtime.call("seed", "den", `den(${this.#runtime.place.kind})`, null, async () => {
      const den = await server({ ...options, place: this.#runtime.place });
      return this.#runtime.stack.use(den);
    });
  }

  desktop(options: SeedDesktopOptions = {}) {
    return this.#runtime.call("seed", "desktop", `desktop(${options.den ? `as ${options.signIn === false ? "signed-out" : options.as ?? "admin"}` : this.#runtime.place.kind})`, null, async () => {
      if (options.den) {
        if (options.signIn === false) {
          return this.#runtime.stack.use(await startApp({
            den: options.den,
            place: this.#runtime.place,
            signIn: false,
            model: options.model,
            workspacePath: options.workspacePath,
            profileDir: options.profileDir,
          }));
        }
        return this.#runtime.stack.use(await startApp({
          den: options.den,
          place: this.#runtime.place,
          as: options.as ?? "admin",
          model: options.model,
          workspacePath: options.workspacePath,
          profileDir: options.profileDir,
        }));
      }
      if (options.as) throw new Error("seed.desktop({ as }) requires a Den.");
      const app = this.#runtime.stack.use(await desktop({
        name: options.name,
        host: this.#runtime.place.host(),
        profileDir: options.profileDir,
        env: options.model ? { OPENWORK_EVAL_MODEL: options.model } : undefined,
      }));
      if (options.workspacePath) await this.workspace(app, options.workspacePath);
      return app;
    });
  }

  web(options: SeedWebOptions) {
    return this.#runtime.call("seed", "web", `web(${options.signedInAs ? "signed in" : "signed out"})`, null, async () => {
      const web = this.#runtime.stack.use(await chrome({
        name: "spec-web",
        host: this.#runtime.place.host(),
        startUrl: options.den.ref.webUrl,
        headless: options.headless,
      }));
      if (options.viewport) await setViewport(web, {
        ...options.viewport,
        deviceScaleFactor: options.viewport.deviceScaleFactor ?? 1,
      });
      if (options.signedInAs !== undefined) {
        const session = sessionFromWebOptions(options);
        const denOrigin = new URL(options.den.ref.webUrl).origin;
        let lastHref = "unobserved";
        const waitForDen = () => eventually(async () => {
          const observation = await evaluateOnSurface(web, `location.origin === ${JSON.stringify(denOrigin)} && document.readyState !== "loading" ? "" : location.href`);
          if (typeof observation === "string") lastHref = observation;
          return observation === "";
        }, { within: 30_000, intervalMs: 250, label: "Den origin document" });
        try {
          await waitForDen();
        } catch {
          await navigate(web.client, options.den.ref.webUrl);
          await waitForDen().catch(() => { throw new Error(`Den origin document did not load; last observed location.href: ${lastHref}`); });
        }
        await callFunctionOnSurface(web, `(token) => {
          localStorage.setItem("openwork:web:auth-token", token);
          return true;
        }`, [session.token]);
      }
      const startPath = options.startPath ?? "/";
      await navigate(web.client, new URL(startPath, options.den.ref.webUrl).toString());
      return web;
    });
  }

  workspace(app: Surface, path = `/tmp/openwork-spec-${Date.now()}`, options: { create?: boolean } = {}) {
    return this.#runtime.call("seed", "workspace", `workspace(${path})`, app, async () => {
      const result = await import("@openwork/behaviors").then(({ createAndSelectWorkspace }) => createAndSelectWorkspace(app, { path, ...options }));
      await eventually(() => callFunctionOnSurface(app, `(workspaceId) => {
        const workspace = window.__openwork?.slice?.("route")?.workspaces?.find(item => item.id === workspaceId);
        return workspace ? { exists: true, loading: workspace.loading } : { exists: false };
      }`, [result.workspaceId]), {
        within: 60000, intervalMs: 250, label: `workspace ${result.workspaceId} initial session load`,
        until: value => isRecord(value) && value.exists === true && value.loading === false,
      });
      return result;
    });
  }

  session(app: Surface, options: { title?: string } = {}) {
    const title = options.title ?? "New task";
    return this.#runtime.call("seed", "session", `session(${JSON.stringify(title)})`, app, async () => {
      const sessionId = await createSessionWhenReady(app);
      if (options.title) await control(app, "session.rename", { sessionId, title });
      return { sessionId, title };
    });
  }

  sessions(app: Surface, titles: readonly string[]) {
    return this.#runtime.call("seed", "sessions", `sessions(${titles.length})`, app, async () => {
      const seeded: { sessionId: string; title: string }[] = [];
      for (const title of titles) {
        const sessionId = await createSessionWhenReady(app);
        await renameSessionAndWait((action, args) => control(app, action, args), sessionId, title);
        seeded.push({ sessionId, title });
      }
      const observed = await listSessions(app);
      const missing = titles.filter((title) => !observed.some((session) => session.title === title));
      if (missing.length > 0) {
        throw new Error(`Seeded session titles were not present after creation. Missing: ${JSON.stringify(missing)}. Observed: ${JSON.stringify(observed)}.`);
      }
      return seeded;
    });
  }

  signIn(app: Surface, member: import("@openwork/behaviors").DenSession, identity: string) {
    return this.#runtime.call("seed", "signIn", `signIn(${identity})`, app, () => signInDesktopAs(app, member, member));
  }

  api(session: import("@openwork/behaviors").DenSession, path: string, init: RequestInit = {}) {
    const method = init.method?.toUpperCase() ?? "GET";
    return this.#runtime.call("seed", "api", `[seed] api ${method} ${path}`, null, () => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${session.token}`);
      return denFetch(session, path, { ...init, headers });
    });
  }

  orgConnection(admin: import("@openwork/behaviors").DenSession, input: import("./types.ts").OrgConnectionInput) {
    return this.#runtime.call("seed", "orgConnection", `orgConnection(${JSON.stringify(input.name)})`, null, () => createOrgConnection(admin, input));
  }

  nativeConnector(admin: import("@openwork/behaviors").DenSession, input: import("@openwork/behaviors").NativeConnectorInput) {
    return this.#runtime.call("seed", "nativeConnector", `nativeConnector(${JSON.stringify(input.name)})`, null, () => createNativeConnector(admin, input));
  }

  mock(options: Parameters<typeof mcpMock>[0] = {}) {
    return this.#runtime.sync("seed", "mock", "mock(mcp)", () => mcpMock(options));
  }

  faultProxy(den: Den) {
    return this.#runtime.call("seed", "faultProxy", `faultProxy(${this.#runtime.place.kind})`, null, async () => {
      const proxy = await startFaultProxy(den.ref, {
        place: this.#runtime.place,
        sandbox: den.placement?.kind === "daytona" ? den.placement.sandboxId : undefined,
      });
      return this.#runtime.stack.use(proxy);
    });
  }

  denLink(den: Den, options: import("@openwork/env").SeedDenLinkOptions = {}) {
    return this.#runtime.call("seed", "denLink", `denLink(${options.client ?? "public-preview"})`, null, async () => {
      const link = await startDenLink(den.ref, options);
      return this.#runtime.stack.use(link);
    });
  }

  tmpPath(label: string): string {
    this.#runtime.checkOrder("seed", "tmpPath");
    return this.#runtime.adapters.seed?.tmpPath?.(label)
      ?? `/tmp/openwork-${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
  }

  composerText(app: Surface, text: string) {
    return this.#runtime.call("seed", "composerText", `composerText(${text.length} chars)`, app, async () => {
      await waitForControlAction(app, "composer.set_text");
      await control(app, "composer.set_text", { text });
    });
  }

  evalIn(surface: Surface, expression: string, options: { args?: readonly import("@openwork/cdp").CdpFunctionArgument[]; awaitPromise?: boolean; timeoutMs?: number } = {}) {
    const { args, ...evaluateOptions } = options;
    return this.#runtime.call("seed:raw", "evalIn", "[seed:raw] evalIn(<expression>)", surface, () => args === undefined
      ? evalIn(surface, expression, evaluateOptions)
      : callFunctionOnSurface(surface, expression, args, evaluateOptions));
  }
}

export class UserChannel implements User {
  readonly #runtime: SpecRuntime;
  readonly #surface: Surface | null;

  constructor(runtime: SpecRuntime, surface: Surface | null) {
    this.#runtime = runtime;
    this.#surface = surface;
  }

  on(surface: Surface): User {
    return new UserChannel(this.#runtime, surface);
  }

  click(target: Target, options: ClickOptions = {}): Promise<void> {
    return this.#click(target, 1, "click", options);
  }

  rightClick(target: Target, options: ClickOptions = {}): Promise<void> {
    const surface = requireSurface(this.#surface);
    const hitTestDetail = options.hitTest === false ? ", hitTest=false" : "";
    return this.#runtime.call("user", "rightClick", `rightClick(${targetDetail(target)}${hitTestDetail})`, surface, async () => {
      if (this.#runtime.adapters.user?.click) return this.#runtime.adapters.user.click(surface, target, 1);
      const found = await waitForLocated(surface, target, { mustHitTest: options.hitTest !== false });
      await clickAt(surface, found.center, { button: "right" });
    });
  }

  dblclick(target: Target): Promise<void> {
    return this.#click(target, 2, "dblclick");
  }

  #click(target: Target, clickCount: number, verb: "click" | "dblclick", options: ClickOptions = {}): Promise<void> {
    const surface = requireSurface(this.#surface);
    const hitTestDetail = options.hitTest === false ? ", hitTest=false" : "";
    return this.#runtime.call("user", verb, `${verb}(${targetDetail(target)}${hitTestDetail})`, surface, async () => {
      if (this.#runtime.adapters.user?.click) return this.#runtime.adapters.user.click(surface, target, clickCount);
      const found = await waitForLocated(surface, target, { mustHitTest: options.hitTest !== false });
      await clickAt(surface, found.center, { clickCount });
    });
  }

  type(target: Target, text: string, options: TypeOptions = {}): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "type", typedTextDetail(target, text, options), surface, async () => {
      if (this.#runtime.adapters.user?.click) await this.#runtime.adapters.user.click(surface, target, 1);
      else {
        const found = await waitForLocated(surface, target, { mustHitTest: true });
        await clickAt(surface, found.center);
      }
      const mac = surface.handle.hostKind !== "daytona" && process.platform === "darwin";
      await pressKey(surface, options.replace ? (mac ? "Meta+A" : "Control+A") : (mac ? "Meta+ArrowDown" : "Control+End"));
      await typeText(surface, text);
    });
  }

  press(key: string): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "press", `press(${key})`, surface, () => pressKey(surface, key));
  }

  hover(target: Target): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "hover", `hover(${targetDetail(target)})`, surface, async () => {
      const found = await waitForLocated(surface, target, { mustHitTest: true });
      await hoverAt(surface, found.center);
    });
  }

  see(target: Target, options: SeeOptions = {}): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "see", seeDetail(target, options), surface, async () => {
      const timeoutMs = options.timeoutMs ?? 30_000;
      const deadline = Date.now() + timeoutMs;
      let found: Located | null = null;
      while (Date.now() < deadline) {
        try {
          found = await locate(surface, target);
          if (found.visible
            && (options.editable === undefined || found.editable === options.editable)
            && (options.value === undefined || found.value === options.value)
            && (options.text === undefined || textMatches(found.text, options.text))) return;
        } catch {
          found = null;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out after ${timeoutMs}ms seeing ${targetDetail(target)}${found ? `; last state ${JSON.stringify(found)}` : ""}. On screen: ${await dumpScreenState(surface)}.`);
    });
  }

  notSee(target: Target, options: { timeoutMs?: number } = {}): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "notSee", `notSee(${targetDetail(target)})`, surface, async () => {
      await assertAbsent(surface, target, options.timeoutMs ?? 3_000);
    });
  }

  reload(): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "reload", "reload", surface, () => reload(surface));
  }

  navigate(url: string): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "navigate", `navigate(${new URL(url).pathname})`, surface, async () => {
      if (surface.handle.kind !== "chrome") throw new Error("user.navigate() is available only on web surfaces.");
      await navigate(surface.client, url);
    });
  }

  screenshot() {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("user", "screenshot", "screenshot", surface, () => screenshot(surface));
  }

  looks(expectations: string[]): Promise<void> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("vision", "looks", `looks(${expectations.length} expectations)`, surface, async () => {
      const artifact = await screenshot(surface);
      const result = await validate(artifact, expectations);
      expectVisualEvidence(result);
    });
  }
}

export class AgentChannel implements Agent {
  readonly #runtime: SpecRuntime;
  readonly #surface: Surface | null;

  constructor(runtime: SpecRuntime, surface: Surface | null) {
    this.#runtime = runtime;
    this.#surface = surface;
  }

  on(surface: Surface): Agent {
    return new AgentChannel(this.#runtime, surface);
  }

  run(action: string, args?: unknown): Promise<unknown> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("agent", "run", `run(${action})`, surface, async () => {
      if (action.startsWith("composer.")) await waitForControlAction(surface, action);
      else await waitForControlRail(surface, action);
      return control(surface, action, args);
    });
  }

  async send(text: string): Promise<unknown> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("agent", "send", `send(${text.length} chars)`, surface, async () => {
      await waitForControlAction(surface, "composer.set_text");
      await control(surface, "composer.set_text", { text });
      await waitForControlAction(surface, "composer.send");
      return control(surface, "composer.send");
    });
  }

  createSession(title?: string): Promise<string> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("agent", "createSession", `createSession(${title ? JSON.stringify(title) : ""})`, surface, async () => {
      const result = await createSessionWhenReady(surface);
      if (title) await control(surface, "session.rename", { sessionId: result, title });
      return result;
    });
  }

  list() {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("agent", "list", "listSessions", surface, () => listSessions(surface));
  }

  actions(): Promise<unknown> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("agent", "actions", "listActions", surface, async () => {
      await waitForControlRail(surface, "listActions");
      return evaluateOnSurface(surface, "window.__openworkControl.listActions()");
    });
  }
}

export class ProbeChannel implements Probe {
  readonly #runtime: SpecRuntime;
  readonly #surface: Surface | null;

  constructor(runtime: SpecRuntime, surface: Surface | null) {
    this.#runtime = runtime;
    this.#surface = surface;
  }

  on(surface: Surface): Probe {
    return new ProbeChannel(this.#runtime, surface);
  }

  text(): Promise<string> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("probe", "text", "text", surface, async () => {
      if (this.#runtime.adapters.probe?.text) return this.#runtime.adapters.probe.text(surface);
      const value = await evaluateOnSurface(surface, "document.body.innerText");
      if (typeof value !== "string") throw new Error("document.body.innerText was not a string.");
      return value;
    });
  }

  has(text: string): Promise<boolean> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("probe", "has", `has(${JSON.stringify(redacted(text))})`, surface, async () => {
      const value = await callFunctionOnSurface(surface, `(wanted) => document.body.innerText.includes(wanted)`, [text]);
      if (typeof value !== "boolean") throw new Error("Text presence probe was not a boolean.");
      return value;
    });
  }

  composer() {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("probe", "composer", "composer", surface, () => readComposerState(surface));
  }

  storage(key: string): Promise<unknown>;
  storage<T>(key: string, pick: (value: unknown) => T): Promise<T>;
  async storage<T>(key: string, pick?: (value: unknown) => T): Promise<unknown> {
    const surface = requireSurface(this.#surface);
    const value = await this.#runtime.call("probe", "storage", `storage(${key})`, surface, async () => {
      const raw = await callFunctionOnSurface(surface, `(storageKey) => localStorage.getItem(storageKey)`, [key]);
      if (raw === null || raw === undefined || raw === "") return null;
      if (typeof raw !== "string") throw new Error(`localStorage ${JSON.stringify(key)} was not a string.`);
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed;
      } catch {
        return raw;
      }
    });
    return pick ? pick(value) : value;
  }

  hash(): Promise<string> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("probe", "hash", "hash", surface, async () => {
      const value = await evaluateOnSurface(surface, "window.location.hash");
      if (typeof value !== "string") throw new Error("window.location.hash was not a string.");
      return value;
    });
  }

  eval(expression: string, options?: ProbeEvalOptions): Promise<unknown>;
  eval(surface: Surface, expression: string, options?: ProbeEvalOptions): Promise<unknown>;
  eval(surfaceOrExpression: Surface | string, expressionOrOptions?: string | ProbeEvalOptions, explicitOptions: ProbeEvalOptions = {}): Promise<unknown> {
    const surface = typeof surfaceOrExpression === "string" ? requireSurface(this.#surface) : surfaceOrExpression;
    const source = typeof surfaceOrExpression === "string"
      ? surfaceOrExpression
      : typeof expressionOrOptions === "string" ? expressionOrOptions : undefined;
    const options = typeof surfaceOrExpression === "string"
      ? typeof expressionOrOptions === "string" ? {} : expressionOrOptions ?? {}
      : explicitOptions;
    if (source === undefined) throw new Error("probe.eval requires an expression.");
    const { args, ...evaluateOptions } = options;
    return this.#runtime.call("probe:raw", "eval", "[probe:raw] eval(<expression>)", surface, () => args === undefined
      ? evalIn(surface, source, evaluateOptions)
      : callFunctionOnSurface(surface, source, args, evaluateOptions));
  }

  connectState(app: Surface) {
    return this.#runtime.call("probe", "connectState", "connectState", app, () => readConnectState(app));
  }

  api(session: import("@openwork/behaviors").DenSession, path: string, init: RequestInit = {}) {
    const method = init.method?.toUpperCase() ?? "GET";
    return this.#runtime.call("probe", "api", `api(GET ${path})`, null, () => {
      if (method !== "GET") throw new Error(`probe.api is read-only; ${method} is not allowed.`);
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${session.token}`);
      return denFetch(session, path, { ...init, method: "GET", headers });
    });
  }

  desktopApi(path: string): Promise<{ status: number; body: unknown }> {
    const surface = requireSurface(this.#surface);
    return this.#runtime.call("probe", "desktopApi", `desktopApi(GET ${path})`, surface, async () => {
      if (!path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path)) {
        throw new Error("probe.desktopApi requires a root-relative server path.");
      }
      const value = await callFunctionOnSurface(surface, `async (path) => {
        const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
        if (!info?.running || !info.baseUrl) return { status: 0, body: { error: "local_server_unavailable" } };
        const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + path, {
          method: "GET",
          headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        const text = await response.text();
        let body = text;
        try { body = text ? JSON.parse(text) : null; } catch {}
        return { status: response.status, body };
      }`, [path], { awaitPromise: true, timeoutMs: 20_000 });
      if (!isRecord(value) || typeof value.status !== "number" || !("body" in value)) {
        throw new Error("Invalid desktop API probe response.");
      }
      return { status: value.status, body: value.body };
    });
  }

  toolCalls(mock: import("@openwork/env").MockHandle, options: Parameters<import("@openwork/env").MockHandle["toolCalls"]>[0] = {}) {
    return this.#runtime.call("probe", "toolCalls", `toolCalls(${options.name ?? "any"})`, null, () => mock.toolCalls(options));
  }

  eventually<T>(fn: () => Promise<T> | T, options: import("../eventually.ts").EventuallyOptions<T>): Promise<T> {
    return this.#runtime.call("probe", "eventually", `eventually(${options.label ?? "condition"})`, null, () => eventually(fn, options));
  }
}

export function channels(runtime: SpecRuntime): { seed: Seed; user: User; agent: Agent; probe: Probe; step: Step } {
  return {
    seed: new SeedChannel(runtime),
    user: new UserChannel(runtime, runtime.primary),
    agent: new AgentChannel(runtime, runtime.primary),
    probe: new ProbeChannel(runtime, runtime.primary),
    step: runtime.step,
  };
}

export function registerWorldDisposable(stack: AsyncDisposableStack, world: unknown): void {
  if (isAsyncDisposable(world) && !isSurface(world)) stack.use(world);
}
