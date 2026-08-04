import type { Shot } from "./screenshot.ts";
import { openTape } from "./tape.ts";
import type { SeenFacts } from "./validate.ts";

export interface Roll {
  dir: string;
  add(shot: Shot, seen?: SeenFacts): Promise<string>;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

let warned = false;

/** @deprecated Use the ambient evidence fixture from @openwork/fraimz/vitest. */
export function photoRoll(name: string, opts: { outDir?: string } = {}): Roll {
  if (!warned) {
    console.warn("[fraimz] photoRoll() is deprecated; use the ambient evidence fixture from @openwork/fraimz/vitest.");
    warned = true;
  }
  const tape = openTape({ name, outDir: opts.outDir });
  return {
    dir: tape.dir,
    async add(shot, seen) {
      const takePath = tape.recordTake(shot);
      return seen ? tape.claim(shot.hash, seen) : takePath;
    },
    close: () => tape.close(),
    async [Symbol.asyncDispose]() {
      await tape.close();
    },
  };
}
