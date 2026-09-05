import type { DenSession, DenFetchResult } from "@openwork/behaviors";
import type { CdpFunctionArgument, Surface, Target } from "@openwork/cdp";
import type {
  MockHandle,
  Place,
  Seed,
  TestNeeds,
} from "@openwork/env";
import type { ScreenshotArtifact, StepRecord, TestEvidenceRecorder, TestOutcome, TraceEntry } from "@openwork/test-evidence";
import type { TestAPI } from "vitest";
import type { EventuallyOptions } from "../eventually.ts";

export interface SeeOptions {
  timeoutMs?: number;
  editable?: boolean;
  value?: string;
  text?: string | RegExp;
}

export interface ClickOptions {
  /** Last resort for an intentionally covered target; still clicks its trusted CDP center. */
  hitTest?: boolean;
}

export interface TypeOptions {
  /** Replace existing text with a real select-all key chord before typing. Defaults to append. */
  replace?: boolean;
}

export interface ProbeEvalOptions {
  args?: readonly CdpFunctionArgument[];
  awaitPromise?: boolean;
  timeoutMs?: number;
}

export interface User {
  click(target: Target, options?: ClickOptions): Promise<void>;
  rightClick(target: Target, options?: ClickOptions): Promise<void>;
  dblclick(target: Target): Promise<void>;
  type(target: Target, text: string, options?: TypeOptions): Promise<void>;
  press(key: string): Promise<void>;
  hover(target: Target): Promise<void>;
  see(target: Target, options?: SeeOptions): Promise<void>;
  notSee(target: Target, options?: { timeoutMs?: number }): Promise<void>;
  reload(): Promise<void>;
  navigate(url: string): Promise<void>;
  screenshot(): Promise<ScreenshotArtifact>;
  looks(expectations: string[]): Promise<void>;
  on(surface: Surface): User;
}

export interface Agent {
  run(action: string, args?: unknown): Promise<unknown>;
  send(text: string): Promise<unknown>;
  createSession(title?: string): Promise<string>;
  list(): Promise<{ sessionId: string; title: string }[]>;
  actions(): Promise<unknown>;
  on(surface: Surface): Agent;
}

export interface Probe {
  text(): Promise<string>;
  has(text: string): Promise<boolean>;
  composer(): ReturnType<typeof import("@openwork/behaviors").readComposerState>;
  connectorCatalog(): ReturnType<typeof import("@openwork/behaviors").readConnectorCatalog>;
  storage(key: string): Promise<unknown>;
  storage<T>(key: string, pick: (value: unknown) => T): Promise<T>;
  hash(): Promise<string>;
  eval(expression: string, options?: ProbeEvalOptions): Promise<unknown>;
  eval(surface: Surface, expression: string, options?: ProbeEvalOptions): Promise<unknown>;
  connectState(app: Surface): ReturnType<typeof import("../state.ts").readConnectState>;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
  /** GET from the bound desktop's local server; authentication stays in the renderer. */
  desktopApi(path: string): Promise<{ status: number; body: unknown }>;
  toolCalls(mock: MockHandle, options?: Parameters<MockHandle["toolCalls"]>[0]): ReturnType<MockHandle["toolCalls"]>;
  eventually<T>(fn: () => Promise<T> | T, options: EventuallyOptions<T>): Promise<T>;
  on(surface: Surface): Probe;
}

export type Step = <T>(name: string, fn: () => Promise<T> | T) => Promise<T>;

export type WorldFn<W> = (seed: Seed, ctx: { place: Place }) => Promise<W>;

export interface SpecBodyContext<W> {
  world: W;
  seed: Seed;
  user: User;
  agent: Agent;
  probe: Probe;
  step: Step;
  evidence: TestEvidenceRecorder;
  place: Place;
}

export type SpecTestApi<W> = TestAPI<SpecBodyContext<W>>;

export interface SpecAdapters {
  seed?: {
    tmpPath?(label: string): string;
  };
  user?: {
    click?(surface: Surface, target: Target, clickCount: number): Promise<void>;
  };
  probe?: {
    text?(surface: Surface): Promise<string>;
  };
  observe?: {
    trace?(entry: TraceEntry): void;
    step?(step: StepRecord): void;
    outcome?(outcome: TestOutcome, failure?: string): void;
  };
}

export interface SpecWorldOptions {
  needs?: TestNeeds;
  timeout?: number;
  scope?: "test" | "file";
  /** Deterministic app-less test seam; production specs must not provide adapters. */
  adapters?: SpecAdapters;
}

export type { OrgConnectionInput, Seed, SeedDesktopOptions, SeedWebOptions } from "@openwork/env";
