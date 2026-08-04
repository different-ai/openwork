import { AsyncLocalStorage } from "node:async_hooks";
import type { Tape } from "./tape.ts";

const tapes = new AsyncLocalStorage<Tape>();

export function currentTape(): Tape | null {
  return tapes.getStore() ?? null;
}

export function withTape<Result>(tape: Tape, fn: () => Result): Result {
  return tapes.run(tape, fn);
}

export function enterTape(tape: Tape): () => void {
  const previous = tapes.getStore();
  tapes.enterWith(tape);
  return () => {
    tapes.disable();
    if (previous) tapes.enterWith(previous);
  };
}
