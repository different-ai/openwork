import type { CdpClient, CdpTarget } from "./cdp.ts";
import type { PrettyOptions } from "./pretty.ts";
import type { Surface, SurfaceFacade } from "./surfaces.ts";

export type { PrettyOptions } from "./pretty.ts";

export type EvalMode = "automation" | "demo";

export type FlowKind = "user-facing" | "internal";

export type EvidenceStatus = "running" | "passed" | "failed";

export interface EvidenceMetadata {
  step?: string | null;
  at?: string;
}

export interface ClaimEvidence extends EvidenceMetadata {
  type: "claim";
  status: EvidenceStatus;
  name?: string;
  claim?: string | null;
  voiceover?: string | null;
}

export interface AssertionEvidence extends EvidenceMetadata {
  type: "assertion";
  status: "passed" | "failed";
  assertion: string;
  actual?: unknown;
}

export interface FrameValidation {
  label: string;
  passed: boolean;
  detail?: string;
}

export interface FrameEvidence extends EvidenceMetadata {
  type: "frame";
  status: "passed" | "failed";
  file: string;
  name: string;
  surface?: string | null;
  claim: string | null;
  voiceover: string | null;
  url: unknown;
  validations: FrameValidation[];
}

export interface OutputEvidence extends EvidenceMetadata {
  type: "output";
  name: string;
  text: string;
}

export type Evidence = ClaimEvidence | AssertionEvidence | FrameEvidence | OutputEvidence;

export type ClaimEvidenceInput = Omit<ClaimEvidence, "step" | "at">;
export type AssertionEvidenceInput = Omit<AssertionEvidence, "step" | "at">;
export type FrameEvidenceInput = Omit<FrameEvidence, "step" | "at">;
export type OutputEvidenceInput = Omit<OutputEvidence, "step" | "at">;
export type EvidenceInput = ClaimEvidenceInput | AssertionEvidenceInput | FrameEvidenceInput | OutputEvidenceInput;

export interface EvalOptions {
  awaitPromise?: boolean;
}

export interface TimeoutOptions {
  timeoutMs?: number;
}

export interface WaitForOptions extends TimeoutOptions {
  label?: string;
}

export interface WaitForTextOptions extends TimeoutOptions {}

export interface WaitForRouteOptions extends TimeoutOptions {}

export interface ClickTextOptions extends TimeoutOptions {
  selector?: string;
}

export interface TrustedClickOptions extends TimeoutOptions {}

export interface FillOptions extends TimeoutOptions {}


export interface ScreenshotOptions {
  name?: string;
  claim?: string;
  voiceover?: string;
  pretty?: boolean | PrettyOptions;
  requireText?: string[];
  rejectText?: string[];
  hashIncludes?: string;
  allowInvalid?: boolean;
  targetId?: string;
  targetUrlIncludes?: string;
  textTargetId?: string;
  textTargetUrlIncludes?: string;
  sandboxCapture?: boolean | "computer-use";
}

export interface ProveOptions {
  claim?: string;
  voiceover?: string;
  action?: () => Promise<void> | void;
  assert?: () => Promise<void> | void;
  screenshot?: string | ScreenshotOptions;
}

export interface SwitchToNewTabOptions extends TimeoutOptions {
  match?: (target: CdpTarget) => boolean;
  label?: string;
  trigger?: () => Promise<void> | void;
}

export interface ReconnectOptions extends TimeoutOptions {}

export interface FlowContext {
  flowId: string;
  env: NodeJS.ProcessEnv;
  cdpBaseUrl: string | null;
  outDir: string;
  client: CdpClient | null;
  logs: string[];
  screenshots: string[];
  evidenceFrames: FrameEvidenceInput[];
  state: Record<string, unknown>;
  surfaces: SurfaceFacade;

  eval(expression: string, options?: EvalOptions): Promise<unknown>;
  assert(condition: unknown, message: string): void;
  skip(reason: string): void;
  log(message: string): void;
  output(name: string, text: unknown): OutputEvidence;
  prove(name: string, options?: ProveOptions): Promise<void>;
  recordEvidence(entry: EvidenceInput): Evidence;
  waitFor(expression: string, options?: WaitForOptions): Promise<unknown>;
  waitForText(text: string, options?: WaitForTextOptions): Promise<void>;
  waitForRoute(expected: string, options?: WaitForRouteOptions): Promise<string>;
  expectRoute(expected: string, options?: WaitForRouteOptions): Promise<AssertionEvidence>;
  hasText(text: string): Promise<boolean>;
  clickText(text: string, options?: ClickTextOptions): Promise<unknown>;
  trustedClick(selector: string, options?: TrustedClickOptions): Promise<string | undefined>;
  fill(selector: string, value: string, options?: FillOptions): Promise<void>;
  navigateHash(path: string): Promise<void>;
  control(actionId: string, args?: unknown): Promise<unknown>;
  expectText(text: string, options?: WaitForTextOptions): Promise<AssertionEvidence>;
  expectNoText(text: string): Promise<AssertionEvidence>;
  expectHashIncludes(fragment: string): Promise<void>;
  screenshot(name: string, options?: ScreenshotOptions): Promise<string>;
  on<T>(surface: string | Surface, fn: () => Promise<T>): Promise<T>;
  switchToNewTab(options?: SwitchToNewTabOptions): Promise<CdpTarget>;
  switchBack(): Promise<void>;
  reconnect(options?: ReconnectOptions): Promise<CdpTarget>;
  ensureLightMode(): Promise<void>;
  beginStep(name: string): void;
  endStep(): Evidence[];
}

export interface FlowStep {
  name: string;
  run(ctx: FlowContext): Promise<void> | void;
}

export interface FlowDefinition {
  id: string;
  title: string;
  kind?: FlowKind;
  spec?: string;
  requiredEnv?: string[];
  requiresApp?: boolean;
  preserveTheme?: boolean;
  precondition?: (ctx: FlowContext) => Promise<string | false | null | undefined> | string | false | null | undefined;
  steps: FlowStep[];
}

export interface LoadedFlow extends FlowDefinition {
  file: string;
}

export type FlowStatus = "passed" | "failed" | "skipped";
export type StepStatus = "passed" | "failed";

export interface StepResult {
  name: string;
  status: StepStatus;
  durationMs: number;
  error: string | null;
  evidence: Evidence[];
}

export interface FlowResult {
  id: string;
  title: string;
  spec: string | null;
  kind: FlowKind | null;
  status: FlowStatus;
  skipReason: string | null;
  steps: StepResult[];
  logs: string[];
  screenshots?: string[];
  evidenceFrames?: FrameEvidenceInput[];
}

export interface SoakFailure {
  iteration: number;
  step: string | null;
  error: string | null;
}

export interface SoakSummary {
  flowId: string;
  title: string;
  repeat: number;
  status: FlowStatus;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  capturedIterations: number[];
  failures: SoakFailure[];
}

export interface EvalReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  cdpUrl: string;
  mode: EvalMode;
  flows: FlowResult[];
  summary: Record<FlowStatus, number>;
  soak?: SoakSummary[];
}

export function defineFlow(flow: FlowDefinition): FlowDefinition {
  return flow;
}
