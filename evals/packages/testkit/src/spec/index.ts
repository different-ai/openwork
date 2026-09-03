import { SkipError, unmetNeeds } from "@openwork/env";
import { fixtureTest, wrapTestApi } from "../fixture.ts";
import {
  BufferedEvidenceSink,
  SeedChannel,
  SpecRuntime,
  channels,
  registerWorldDisposable,
  replayEvidence,
} from "./runtime.ts";
import type { Place, TestNeeds } from "@openwork/env";
import type {
  Agent,
  Probe,
  Seed,
  SpecTestApi,
  SpecWorldOptions,
  Step,
  User,
  WorldFn,
} from "./types.ts";

interface ReadyWorld<W> {
  state: "ready";
  world: W;
  runtime: SpecRuntime;
  buffer: BufferedEvidenceSink;
}

interface SkippedWorld {
  state: "skipped";
  reason: string;
  runtime: SpecRuntime;
  buffer: BufferedEvidenceSink;
}

interface FailedWorld {
  state: "failed";
  error: unknown;
  runtime: SpecRuntime;
  buffer: BufferedEvidenceSink;
}

type WorldState<W> = ReadyWorld<W> | SkippedWorld | FailedWorld;

interface RuntimeContext<W> {
  world: W;
  seed: Seed;
  user: User;
  agent: Agent;
  probe: Probe;
  step: Step;
}

function combinedNeeds(filepath: string, needs: TestNeeds | undefined): TestNeeds {
  const e2eOptIn = filepath.endsWith(".e2e.test.ts") ? ["OPENWORK_EVAL_E2E_TESTS"] : [];
  return {
    ...needs,
    optIn: [...new Set([...e2eOptIn, ...(needs?.optIn ?? [])])],
  };
}

async function buildWithTimeout<W>(worldFn: WorldFn<W>, seed: Seed, place: Place, timeout: number | undefined): Promise<W> {
  if (timeout === undefined) return worldFn(seed, { place });
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      worldFn(seed, { place }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`World setup timed out after ${timeout}ms.`)), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function world<W>(worldFn: WorldFn<W>, options?: SpecWorldOptions): SpecTestApi<W>;
function world<W>(worldFn: WorldFn<W>, options: SpecWorldOptions = {}) {
  const scope = options.scope ?? "test";
  const api = fixtureTest.extend<{
    specWorldState: WorldState<W>;
    specRuntimeContext: RuntimeContext<W>;
    world: W;
    seed: Seed;
    user: User;
    agent: Agent;
    probe: Probe;
    step: Step;
  }>({
    specWorldState: [async ({ place, task }, use) => {
      const stack = new AsyncDisposableStack();
      const buffer = new BufferedEvidenceSink();
      const runtime = new SpecRuntime(place, stack, buffer, options.adapters);
      try {
        const missing = unmetNeeds(combinedNeeds(task.file.filepath, options.needs), process.env);
        if (missing.length > 0) {
          await use({ state: "skipped", reason: missing.join(", "), runtime, buffer });
          return;
        }
        try {
          const built = await buildWithTimeout(worldFn, new SeedChannel(runtime), place, options.timeout);
          registerWorldDisposable(stack, built);
          runtime.setPrimary(built);
          await use({ state: "ready", world: built, runtime, buffer });
        } catch (error) {
          if (error instanceof SkipError) {
            await use({ state: "skipped", reason: error.reason, runtime, buffer });
            return;
          }
          runtime.failWorld(error);
          await use({ state: "failed", error, runtime, buffer });
        }
      } finally {
        await stack.disposeAsync();
      }
    }, { scope }],
    specRuntimeContext: async ({ specWorldState, evidence, skip }, use) => {
      replayEvidence(specWorldState.buffer, evidence);
      const bodyRuntime = new SpecRuntime(
        specWorldState.runtime.place,
        specWorldState.runtime.stack,
        evidence,
        options.adapters,
      );
      if (specWorldState.state === "skipped") {
        bodyRuntime.setOutcome("skipped", `needs: ${specWorldState.reason}`);
        return skip(`needs: ${specWorldState.reason}`);
      }
      if (specWorldState.state === "failed") throw specWorldState.error;
      bodyRuntime.stage = "body";
      bodyRuntime.setPrimary(specWorldState.world);
      const bound = channels(bodyRuntime);
      await use({ world: specWorldState.world, ...bound });
    },
    world: async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: W) => Promise<void>,
    ) => use(specRuntimeContext.world),
    seed: async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: Seed) => Promise<void>,
    ) => use(specRuntimeContext.seed),
    user: async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: User) => Promise<void>,
    ) => use(specRuntimeContext.user),
    agent: async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: Agent) => Promise<void>,
    ) => use(specRuntimeContext.agent),
    probe: async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: Probe) => Promise<void>,
    ) => use(specRuntimeContext.probe),
    step: [async (
      { specRuntimeContext }: { specRuntimeContext: RuntimeContext<W> },
      use: (value: Step) => Promise<void>,
    ) => use(specRuntimeContext.step), {}],
  });
  return wrapTestApi(api);
}

export const spec = { world };

export { SeedBeforeActError } from "./runtime.ts";
export type {
  Agent,
  Probe,
  Seed,
  SpecAdapters,
  SpecBodyContext,
  SpecTestApi,
  SpecWorldOptions,
  Step,
  User,
  WorldFn,
} from "./types.ts";
