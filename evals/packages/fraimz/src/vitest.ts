import { expect, test as base } from "vitest";
import { enterTape } from "./ambient.ts";
import { openTape } from "./tape.ts";
import type { Tape } from "./tape.ts";
import type { SeenFacts } from "./validate.ts";

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "test";
}

export const test = base.extend<{ evidence: Tape }>({
  evidence: [async ({ task }, use) => {
    const tape = openTape({ name: slug(task.name) });
    const leaveTape = enterTape(tape);
    try {
      await use(tape);
    } finally {
      leaveTape();
      await tape.close();
    }
  }, { auto: true }],
});

export function expectFrame(seen: SeenFacts): void {
  expect(seen.ok, seen.why).toBe(true);
}
