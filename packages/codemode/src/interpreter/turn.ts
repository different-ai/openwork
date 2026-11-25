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
  private readonly handbacks: Array<Handback> = []
  private first: Waiter | undefined
  private last: Waiter | undefined
  private nesting = 0

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
      return Effect.sync(() => {
        if (this.holder === fiber) this.release(fiber)
        else waiter.removed = true
      })
    })
  })

  hold<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.withFiber((fiber) =>
      Effect.andThen(this.take, effect).pipe(Effect.ensuring(Effect.sync(() => this.release(fiber)))),
    )
  }

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
          const index = this.handbacks.lastIndexOf(back)
          if (index >= 0) this.handbacks.splice(index, 1)
          this.handBack(back)
        })
        return back.returned ? Effect.succeed(fiber) : Effect.as(awaitHandback(back), fiber)
      })
    })
  }

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
    if (next !== undefined) next.fiber.currentDispatcher.scheduleTask(() => next.resume(Effect.void), 0)
  }

  private handBack(back: Handback): void {
    back.returned = true
    const resume = back.resume
    if (resume !== undefined) back.fiber.currentDispatcher.scheduleTask(() => resume(Effect.void), 0)
  }

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

const awaitHandback = (back: Handback) =>
  Effect.callback<void>((resume) => {
    if (back.returned) resume(Effect.void)
    else back.resume = resume
  })
