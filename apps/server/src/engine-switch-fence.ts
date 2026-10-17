import { ApiError } from "./errors.js";

type Engine = "v1" | "v2";

interface FenceState {
  active: number;
  pending: number;
  tail: Promise<void>;
  drained: Set<() => void>;
  generation: number;
  selected?: Engine;
}

// Use the shared ServerConfig object's identity, without importing server/config
// modules. Reads do not enter this gate and remain available during a handoff.
const states = new WeakMap<object, FenceState>();

function stateFor(config: object): FenceState {
  let state = states.get(config);
  if (!state) {
    state = { active: 0, pending: 0, tail: Promise.resolve(), drained: new Set(), generation: 0 };
    states.set(config, state);
  }
  return state;
}

async function waitFor(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

/** Hold until the forwarded mutation finishes (including its response body).
 * New mutations wait behind pending switches; a mutation queued for an engine
 * replaced by a successful switch receives 409 and must resolve routing again.
 * Explicit engine mutations outside a transition are deliberately not blocked.
 */
export async function enterEngineMutation(config: object, engine: Engine, signal?: AbortSignal): Promise<() => Promise<void>> {
  const state = stateFor(config);
  const generation = state.generation;
  signal?.throwIfAborted();
  while (state.pending) await waitFor(state.tail, signal);
  signal?.throwIfAborted();
  if (generation !== state.generation && state.selected !== engine) {
    throw new ApiError(409, "engine_changed", "The selected engine changed while this request waited. Retry the request.");
  }
  state.active++;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (--state.active === 0) {
      for (const resolve of state.drained) resolve();
      state.drained.clear();
    }
  };
}

/** Block new mutations immediately, drain forwarded HTTP mutations, then run
 * the final idle/revision/routing commit. This does not stop running tasks:
 * operation must reject if the engine is not idle. Start the destination engine
 * before entering this short fence. All callers must share config identity.
 *
 * operation must resolve only after routing has committed, and must leave the
 * source selected if it throws. Successful transitions alone invalidate queued
 * requests; a failed switch releases them without changing their engine.
 */
export async function withEngineSwitchFence<T>(config: object, options: {
  from: Engine;
  to: Engine;
  operation: () => Promise<T>;
}): Promise<T> {
  const state = stateFor(config);
  const previous = state.tail;
  let finish: () => void = () => {};
  state.tail = new Promise<void>(resolve => { finish = resolve; });
  state.pending++;
  try {
    await previous;
    if (state.active) await new Promise<void>(resolve => state.drained.add(resolve));
    const result = await options.operation();
    if (options.from !== options.to) {
      state.selected = options.to;
      state.generation++;
    }
    return result;
  } finally {
    state.pending--;
    finish();
  }
}
