import type { DenSession, DenFetchResult, NativeConnectorInput } from "@openwork/behaviors";
import type { AttachedSurface, Surface, Target } from "@openwork/cdp";
import type {
  App,
  Den,
  FaultProxy,
  MockBoot,
  MockHandle,
  Place,
  ServerOptions,
  TestNeeds,
} from "@openwork/env";
import type { DesktopHandle } from "@openwork/hosts";
import type { ScreenshotArtifact, StepRecord, TestEvidenceRecorder, TestOutcome, TraceEntry } from "@openwork/test-evidence";
import type { TestAPI } from "vitest";
import type { EventuallyOptions } from "../eventually.ts";

export interface SeedDesktopOptions {
  den?: Den;
  as?: string;
  signIn?: false;
  model?: string;
  workspacePath?: string;
  profileDir?: string;
  name?: string;
}

export interface SeedWebOptions {
  den: Den;
  signedInAs?: DenSession | "admin" | string;
  startPath?: string;
  headless?: boolean;
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
}

export interface OrgConnectionInput {
  name: string;
  url: string;
  authType: string;
  credentialMode: string;
  access: { orgWide: boolean };
}

export interface Seed {
  den(options?: Omit<ServerOptions, "place">): Promise<Den>;
  desktop(options?: SeedDesktopOptions): Promise<App | DesktopHandle>;
  web(options: SeedWebOptions): Promise<AttachedSurface>;
  workspace(app: Surface, path?: string): Promise<{ workspaceId: string; route: string }>;
  session(app: Surface, options?: { title?: string }): Promise<{ sessionId: string; title: string }>;
  sessions(app: Surface, titles: readonly string[]): Promise<{ sessionId: string; title: string }[]>;
  signIn(app: Surface, member: DenSession): Promise<void>;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
  orgConnection(admin: DenSession, input: OrgConnectionInput): Promise<{ id: string; name: string }>;
  nativeConnector(admin: DenSession, input: NativeConnectorInput): Promise<{ id: string; name: string }>;
  mock(options?: Parameters<typeof import("@openwork/env").mcpMock>[0]): MockBoot;
  faultProxy(den: Den): Promise<FaultProxy>;
  tmpPath(label: string): string;
  composerText(app: Surface, text: string): Promise<void>;
  /** Migration-only raw write escape hatch. New specs must not use it. */
  evalIn(surface: Surface, expression: string): Promise<unknown>;
}

export interface SeeOptions {
  timeoutMs?: number;
  editable?: boolean;
  value?: string;
  text?: string;
}

export interface User {
  click(target: Target): Promise<void>;
  dblclick(target: Target): Promise<void>;
  type(target: Target, text: string): Promise<void>;
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
  storage(key: string): Promise<unknown>;
  storage<T>(key: string, pick: (value: unknown) => T): Promise<T>;
  hash(): Promise<string>;
  eval(expression: string): Promise<unknown>;
  eval(surface: Surface, expression: string): Promise<unknown>;
  api(session: DenSession, path: string, init?: RequestInit): Promise<DenFetchResult>;
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
