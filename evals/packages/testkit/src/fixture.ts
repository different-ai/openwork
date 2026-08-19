import { test as evidenceTest } from "@openwork/test-evidence/vitest";
import { setBriefTestRegistrar } from "./brief-internal.ts";
import { SkipError } from "./needs.ts";
import { resolvePlace } from "./place.ts";

const fixtureTest = evidenceTest.extend<{ place: ReturnType<typeof resolvePlace> }>({
  place: [async ({}, use) => {
    await use(resolvePlace(process.env));
  }, { auto: true }],
});

interface WrappedContext {
  place: ReturnType<typeof resolvePlace>;
  evidence: unknown;
  skip(note?: string): never;
}

// Vitest does not propagate a test-body error back through fixture `use()`, so
// the exported test boundary is where SkipError can reliably become ctx.skip().
function wrapTestApi<T extends (...args: never[]) => unknown>(api: T): T {
  return new Proxy(api, {
    apply(target, thisArg, argArray) {
      const args = [...argArray];
      const callback = args.at(-1);
      if (typeof callback === "function") {
        args[args.length - 1] = async ({ place, evidence, skip }: WrappedContext) => {
          try {
            return await Reflect.apply(callback, undefined, [{ place, evidence, skip }]);
          } catch (error) {
            if (!(error instanceof SkipError)) throw error;
            return skip(`needs: ${error.reason}`);
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
