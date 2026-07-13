/**
 * bun's mock.module replaces a module for the whole test process, so a mock
 * installed by one test file leaks into every file that runs after it. These
 * helpers make a mock delegate to the real implementation except while the
 * owning file's tests are running: flip the returned scope on in beforeEach
 * and off in afterEach/afterAll, and other files keep real behavior
 * regardless of execution order.
 */
export type MockScope = { active: boolean }

export function createMockScope(): MockScope {
  return { active: false }
}

/** Object whose property access resolves against the stub only while the scope is active. */
export function scopedValue<T extends object>(scope: MockScope, real: () => T, stub: T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const source = scope.active ? stub : real()
      const value = (source as Record<PropertyKey, unknown>)[prop]
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(source) : value
    },
  })
}

/** Function that dispatches to the stub only while the scope is active. */
export function scopedFn<TArgs extends unknown[], TResult>(
  scope: MockScope,
  real: () => (...args: TArgs) => TResult,
  stub: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => (scope.active ? stub(...args) : real()(...args))
}
