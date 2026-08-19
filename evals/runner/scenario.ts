import { resolveActors } from "./actors.ts";
import type { Actor, ActorSpec } from "./actors.ts";
import type {
  AssertionEvidence,
  ClickTextOptions,
  EvalOptions,
  Evidence,
  EvidenceInput,
  FillOptions,
  FlowContext,
  FlowDefinition,
  FlowKind,
  FrameEvidenceInput,
  OutputEvidence,
  ProveOptions,
  ReconnectOptions,
  ScreenshotOptions,
  SwitchToNewTabOptions,
  TrustedClickOptions,
  WaitForOptions,
  WaitForRouteOptions,
  WaitForTextOptions,
} from "./flow.ts";
import type { CdpClient, CdpTarget } from "./cdp.ts";
import type { DenServiceOptions } from "./hosts/types.ts";
import type { Surface } from "./surfaces.ts";

const NEEDS_DEN_STACK = "Scenario needs a Den stack: run `pnpm owt up` or `pnpm evals:legacy --stack den` first";

export interface ScenarioContext extends FlowContext {
  actors: Record<string, Actor>;
}

export interface ScenarioStep {
  name: string;
  run(ctx: ScenarioContext): Promise<void> | void;
}

export interface ScenarioDefinition {
  id: string;
  title: string;
  kind?: FlowKind;
  spec?: string;
  requiredEnv?: string[];
  requiresApp?: boolean;
  preserveTheme?: boolean;
  stage?: {
    den?: DenServiceOptions & { require?: boolean };
  };
  actors?: Record<string, ActorSpec>;
  steps: ScenarioStep[];
}

const actorsByContext = new WeakMap<FlowContext, Record<string, Actor>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOrgMode(value: unknown): value is "single_org" | "multi_org" {
  return value === "single_org" || value === "multi_org";
}

function isActorRole(value: unknown): value is Actor["role"] {
  return value === "owner" || value === "member" || value === "fresh";
}

function actorMapFromUnknown(value: unknown): Record<string, Actor> | null {
  if (!isRecord(value)) return null;
  const actors: Record<string, Actor> = {};
  for (const [name, actor] of Object.entries(value)) {
    if (!isRecord(actor) || typeof actor.name !== "string" || typeof actor.email !== "string" || typeof actor.password !== "string" || !isActorRole(actor.role)) {
      return null;
    }
    actors[name] = { name: actor.name, email: actor.email, password: actor.password, role: actor.role };
  }
  return actors;
}

function cleanUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function runtimeConfigUrl(webUrl: string): string {
  return `${cleanUrl(webUrl)}/api/runtime-config`;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runtimeOrgMode(webUrl: string): Promise<"single_org" | "multi_org"> {
  const url = runtimeConfigUrl(webUrl);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (isRecord(body) && isOrgMode(body.orgMode)) return body.orgMode;
  throw new Error("response did not include orgMode");
}

function actorsFor(ctx: FlowContext, spec: Record<string, ActorSpec>): Record<string, Actor> {
  const existing = actorsByContext.get(ctx);
  if (existing) return existing;
  const actors = resolveActors(spec, ctx.env);
  actorsByContext.set(ctx, actors);
  return actors;
}

function hasActors(value: unknown): value is { actors: Record<string, Actor> } {
  return isRecord(value) && actorMapFromUnknown(value.actors) !== null;
}

export function scenarioActors(ctx: FlowContext): Record<string, Actor> {
  if (hasActors(ctx)) return ctx.actors;
  const actors = actorsByContext.get(ctx);
  if (actors) return actors;
  const stateActors = ctx.state.__actors;
  const stateActorMap = actorMapFromUnknown(stateActors);
  if (stateActorMap) return stateActorMap;
  throw new Error("Scenario actors are only available inside a scenario step.");
}

function withActors(ctx: FlowContext, actors: Record<string, Actor>): ScenarioContext {
  ctx.state.__actors = actors;
  return {
    actors,
    get flowId(): string { return ctx.flowId; },
    get env(): NodeJS.ProcessEnv { return ctx.env; },
    get cdpBaseUrl(): string | null { return ctx.cdpBaseUrl; },
    get outDir(): string { return ctx.outDir; },
    get client(): CdpClient | null { return ctx.client; },
    set client(value: CdpClient | null) { ctx.client = value; },
    get logs(): string[] { return ctx.logs; },
    get screenshots(): string[] { return ctx.screenshots; },
    get evidenceFrames(): FrameEvidenceInput[] { return ctx.evidenceFrames; },
    get state(): Record<string, unknown> { return ctx.state; },
    get surfaces() { return ctx.surfaces; },
    eval(expression: string, options?: EvalOptions): Promise<unknown> { return ctx.eval(expression, options); },
    assert(condition: unknown, message: string): void { ctx.assert(condition, message); },
    skip(reason: string): void { ctx.skip(reason); },
    log(message: string): void { ctx.log(message); },
    output(name: string, text: unknown): OutputEvidence { return ctx.output(name, text); },
    prove(name: string, options?: ProveOptions): Promise<void> { return ctx.prove(name, options); },
    recordEvidence(entry: EvidenceInput): Evidence { return ctx.recordEvidence(entry); },
    waitFor(expression: string, options?: WaitForOptions): Promise<unknown> { return ctx.waitFor(expression, options); },
    waitForText(text: string, options?: WaitForTextOptions): Promise<void> { return ctx.waitForText(text, options); },
    waitForRoute(expected: string, options?: WaitForRouteOptions): Promise<string> { return ctx.waitForRoute(expected, options); },
    expectRoute(expected: string, options?: WaitForRouteOptions): Promise<AssertionEvidence> { return ctx.expectRoute(expected, options); },
    hasText(text: string): Promise<boolean> { return ctx.hasText(text); },
    clickText(text: string, options?: ClickTextOptions): Promise<unknown> { return ctx.clickText(text, options); },
    trustedClick(selector: string, options?: TrustedClickOptions): Promise<string | undefined> { return ctx.trustedClick(selector, options); },
    fill(selector: string, value: string, options?: FillOptions): Promise<void> { return ctx.fill(selector, value, options); },
    navigateHash(path: string): Promise<void> { return ctx.navigateHash(path); },
    control(actionId: string, args?: unknown): Promise<unknown> { return ctx.control(actionId, args); },
    expectText(text: string, options?: WaitForTextOptions): Promise<AssertionEvidence> { return ctx.expectText(text, options); },
    expectNoText(text: string): Promise<AssertionEvidence> { return ctx.expectNoText(text); },
    expectHashIncludes(fragment: string): Promise<void> { return ctx.expectHashIncludes(fragment); },
    screenshot(name: string, options?: ScreenshotOptions): Promise<string> { return ctx.screenshot(name, options); },
    switchToNewTab(options?: SwitchToNewTabOptions): Promise<CdpTarget> { return ctx.switchToNewTab(options); },
    switchBack(): Promise<void> { return ctx.switchBack(); },
    reconnect(options?: ReconnectOptions): Promise<CdpTarget> { return ctx.reconnect(options); },
    ensureLightMode(): Promise<void> { return ctx.ensureLightMode(); },
    beginStep(name: string): void { ctx.beginStep(name); },
    endStep(): Evidence[] { return ctx.endStep(); },
    on<T>(surface: string | Surface, fn: () => Promise<T>): Promise<T> { return ctx.on(surface, fn); },
  };
}

function denPrecondition(stageDen: DenServiceOptions): (ctx: FlowContext) => Promise<string | false> {
  return async (ctx) => {
    const apiUrl = ctx.env.OPENWORK_EVAL_DEN_API_URL?.trim();
    const webUrl = ctx.env.OPENWORK_EVAL_DEN_WEB_URL?.trim();
    if (!apiUrl || !webUrl) return NEEDS_DEN_STACK;
    if (!stageDen.orgMode) return false;
    try {
      const actualOrgMode = await runtimeOrgMode(webUrl);
      if (actualOrgMode !== stageDen.orgMode) {
        return `Scenario needs Den orgMode ${stageDen.orgMode}, but ${runtimeConfigUrl(webUrl)} reports ${actualOrgMode}.`;
      }
      return false;
    } catch (error) {
      if (stageDen.orgMode === "multi_org" && ctx.env.OPENWORK_EVAL_DEN_MULTI_ORG?.trim()) {
        ctx.log(`Runtime config probe failed at ${runtimeConfigUrl(webUrl)}; honoring OPENWORK_EVAL_DEN_MULTI_ORG fallback: ${messageText(error)}`);
        return false;
      }
      return `Scenario needs a Den stack runtime config at ${runtimeConfigUrl(webUrl)}: ${messageText(error)}`;
    }
  };
}

export function defineScenario(def: ScenarioDefinition): FlowDefinition {
  const actorSpec = def.actors ?? {};
  const precondition = def.stage?.den ? denPrecondition(def.stage.den) : undefined;
  return {
    id: def.id,
    title: def.title,
    kind: def.kind,
    spec: def.spec,
    requiredEnv: def.requiredEnv ? [...def.requiredEnv] : undefined,
    requiresApp: def.requiresApp ?? true,
    preserveTheme: def.preserveTheme,
    precondition,
    steps: def.steps.map((step) => ({
      name: step.name,
      run: (ctx) => step.run(withActors(ctx, actorsFor(ctx, actorSpec))),
    })),
  };
}
