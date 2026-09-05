import { test as evidenceTest } from "@openwork/test-evidence/vitest";
import { SkipError, resolvePlace } from "@openwork/env";
import { setBriefTestRegistrar } from "./brief-internal.ts";
import type { TestEvidenceRecorder } from "@openwork/test-evidence";

export const fixtureTest = evidenceTest.extend<{ place: ReturnType<typeof resolvePlace> }>({
  place: [async ({}, use) => {
    await use(resolvePlace(process.env));
  }, { auto: true, scope: "file" }],
});

interface WrappedContext {
  place: ReturnType<typeof resolvePlace>;
  evidence: TestEvidenceRecorder;
  world?: unknown;
  seed?: unknown;
  user?: unknown;
  agent?: unknown;
  probe?: unknown;
  step?: unknown;
  specRuntimeContext?: { step: unknown };
  skip(note?: string): never;
}

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Vitest does not propagate a test-body error back through fixture `use()`, so
// the exported test boundary is where SkipError can reliably become ctx.skip().
export function wrapTestApi<T extends (...args: never[]) => unknown>(api: T): T {
  return new Proxy(api, {
    apply(target, thisArg, argArray) {
      const args = [...argArray];
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = async ({ place, evidence, world, seed, user, agent, probe, step, specRuntimeContext, skip }: WrappedContext) => {
          let skipping = false;
          const wrappedSkip = (note?: string): never => {
            skipping = true;
            evidence.setOutcome("skipped", note);
            return skip(note);
          };
          try {
            const result = await Reflect.apply(callback, undefined, [{
              place,
              evidence,
              world,
              seed,
              user,
              agent,
              probe,
              step: typeof step === "function" ? step : specRuntimeContext?.step,
              skip: wrappedSkip,
            }]);
            evidence.setOutcome("passed");
            return result;
          } catch (error) {
            if (error instanceof SkipError) return wrappedSkip(`needs: ${error.reason}`);
            if (!skipping) evidence.setOutcome("failed", messageText(error));
            throw error;
          }
        };
      }
      return Reflect.apply(target, thisArg, args);
    },
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = Reflect.apply(value, target, args);
        return typeof result === "function" ? wrapTestApi(result) : result;
      };
    },
  });
}

export const test = wrapTestApi(fixtureTest);

setBriefTestRegistrar((title, fn) => {
  test(title, fn);
});
