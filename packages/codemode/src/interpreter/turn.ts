import { Cause, Effect, Exit, type Fiber, type Scope } from "effect"

type Waiter = {
  readonly fiber: Fiber.Fiber<unknown, unknown>
  readonly resume: (effect: Effect.Effect<void>) => void
  next?: Waiter
  removed: boolean
}

type Handback = {
  readonly fiber: Fiber.Fiber<unknown, unknown>
  returned: boolean
  resume?: (effect: Effect.Effect<void>) => void
}

// Async calls that synchronous starts may nest on the host stack. Deeper ones start through the
// scheduler, so recursion before a first await cannot overflow the host stack.
const MAX_NESTING = 100

/**
 * The right to run program code. JavaScript runs one job at a time: code between two awaits
 * finishes before another job starts. Effect preempts a busy fiber so timeouts and tool calls
 * still run, so only the fiber holding the turn may evaluate program code. An async call lends
 * its fiber the caller's turn and gets it back when the callee first waits or ends; a wait gives
 * the turn to the next ready fiber and queues to take it back. Tool calls run no program code,
 * so they run without it and stay concurrent.
 *
 * Adapted from anomalyco/opencode#54276.
 */
export class Turn {
  private holder: Fiber.Fiber<unknown, unknown> | undefined
  // Callers waiting for a callee to hand the turn back, innermost last.
  private readonly handbacks: Array<Handback> = []
  // Fibers waiting to take the turn, in the order they became ready.
  private first: Waiter | undefined
  private last: Waiter | undefined
  private nesting = 0

  // Take the turn when it is free, after the fibers already waiting.
  private readonly take: Effect.Effect<void> = Effect.withFiber((fiber) => {
    if (this.holder === undefined) {
      this.holder = fiber
      return Effect.void
    }
    return Effect.callback<void>((resume) => {
      const waiter: Waiter = { fiber, resume, removed: false }
      if (this.last === undefined) this.first = waiter
      else this.last.next = waiter
      this.last = waiter
      // Interrupted while waiting, or after the turn was granted but before it ran.
      return Effect.sync(() => {
        if (this.holder === fiber) this.release(fiber)
        else waiter.removed = true
      })
    })
  })

  // Run `effect` holding the turn, as the program's main fiber does.
  hold<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.withFiber((fiber) =>
      Effect.andThen(this.take, effect).pipe(Effect.ensuring(Effect.sync(() => this.release(fiber)))),
    )
  }

  // Wait without the turn, then queue for it like any fiber that became ready. An interrupted
  // fiber stops without it.
  suspend<A, E, R>(wait: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.withFiber((fiber) => {
        this.release(fiber)
        return Effect.flatMap(Effect.exit(restore(wait)), (exit) =>
          Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? exit : Effect.andThen(restore(this.take), exit),
        )
      }),
    )
  }

  // Fork a fiber that runs program code. It starts with the caller's turn, and the caller
  // continues once the fiber first waits or ends.
  fork<A, E, R>(effect: Effect.Effect<A, E, R>, scope: Scope.Scope): Effect.Effect<Fiber.Fiber<A, E>, never, R> {
    return Effect.withFiber((caller) => {
      const back: Handback = { fiber: caller, returned: false }
      this.handbacks.push(back)
      let started = false
      const body = Effect.withFiber((fiber) => {
        started = true
        this.holder = fiber
        return effect
      })
      const forked =
        this.nesting < MAX_NESTING
          ? this.nest(Effect.forkIn(body, scope, { startImmediately: true }))
          : Effect.forkIn(body, scope)
      return Effect.flatMap(forked, (fiber) => {
        fiber.addObserver(() => {
          if (started) return this.release(fiber)
          // Forked into a closing scope: it never took the turn, so the caller keeps it.
          const index = this.handbacks.lastIndexOf(back)
          if (index >= 0) this.handbacks.splice(index, 1)
          this.handBack(back)
        })
        // A callee that waits or ends during the fork has already handed the turn back.
        return back.returned ? Effect.succeed(fiber) : Effect.as(awaitHandback(back), fiber)
      })
    })
  }

  // Give up the turn, back to the innermost caller waiting for it or to the next waiting fiber.
  private release(fiber: Fiber.Fiber<unknown, unknown>): void {
    if (this.holder !== fiber) return
    const back = this.handbacks.pop()
    if (back !== undefined) {
      this.holder = back.fiber
      this.handBack(back)
      return
    }
    let next = this.first
    while (next !== undefined && next.removed) next = next.next
    this.first = next?.next
    if (this.first === undefined) this.last = undefined
    this.holder = next?.fiber
    // Resume in the scheduler, as a yield would: release can run inside another fiber's step.
    if (next !== undefined) next.fiber.currentDispatcher.scheduleTask(() => next.resume(Effect.void), 0)
  }

  // Resume a waiting caller in the scheduler: resumed inline, it would run to its next wait and
  // queue before the callee that just waited has queued its own continuation.
  private handBack(back: Handback): void {
    back.returned = true
    const resume = back.resume
    if (resume !== undefined) back.fiber.currentDispatcher.scheduleTask(() => resume(Effect.void), 0)
  }

  // Run `effect`, which can start another program fiber inside the current step, counting the nesting.
  private nest<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.suspend(() => {
      this.nesting++
      return Effect.ensuring(
        effect,
        Effect.sync(() => {
          this.nesting--
        }),
      )
    })
  }
}

// Checked when the caller suspends: it can be preempted after deciding to wait.
const awaitHandback = (back: Handback) =>
  Effect.callback<void>((resume) => {
    if (back.returned) resume(Effect.void)
    else back.resume = resume
  })
