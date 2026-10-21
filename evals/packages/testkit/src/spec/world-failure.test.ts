import { expect, test } from "vitest";
import { resolvePlace } from "@openwork/env";
import { buildWithTimeout } from "./index.ts";
import { BufferedEvidenceSink, SeedChannel, SpecRuntime } from "./runtime.ts";

function fixture() {
  const stack = new AsyncDisposableStack();
  const place = resolvePlace({});
  const seed = new SeedChannel(new SpecRuntime(place, stack, new BufferedEvidenceSink()));
  return { stack, place, seed };
}

test("world construction failure remains first when its real disposable stack also fails", async () => {
  const { stack, place, seed } = fixture();
  const original = new Error("original world construction failed");
  const cleanup = new Error("profile inspection refused deletion");
  const build = buildWithTimeout(async () => {
    stack.defer(async () => { throw cleanup; });
    throw original;
  }, seed, place, stack, undefined);
  await expect(build).rejects.toMatchObject({
    message: "World setup failed; cleanup also failed", errors: [original, cleanup], cause: original,
  });
  expect(stack.disposed).toBe(true);
  await expect(stack.disposeAsync()).resolves.toBeUndefined();
});

test("successful cleanup does not wrap or replace the original world failure", async () => {
  const { stack, place, seed } = fixture();
  const original = new Error("original world construction failed");
  let cleaned = false;
  await expect(buildWithTimeout(async () => {
    stack.defer(async () => { cleaned = true; });
    throw original;
  }, seed, place, stack, 1_000)).rejects.toBe(original);
  expect(cleaned).toBe(true);
});

test("a successful world keeps its owned resources until final fixture teardown", async () => {
  const { stack, place, seed } = fixture();
  let cleaned = false;
  const world = { [Symbol.asyncDispose]: async () => { cleaned = true; } };
  await expect(buildWithTimeout(async () => world, seed, place, stack, undefined)).resolves.toBe(world);
  expect(cleaned).toBe(false);
  expect(stack.disposed).toBe(false);
  await stack.disposeAsync();
  expect(cleaned).toBe(true);
});
