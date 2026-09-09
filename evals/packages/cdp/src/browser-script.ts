/** A checked browser callback and explicit data; it never runs in the test process. */
export interface BrowserScript<T> {
  readonly callback: (...args: never) => T;
  readonly args: readonly unknown[];
}

export type BrowserEvaluation<T = unknown> = BrowserScript<T> | (() => T);

export function browserScript<Args extends unknown[], T>(callback: (...args: Args) => T, args: [...Args]): BrowserScript<T> {
  return { callback, args };
}

/** Serialize data as JavaScript literals, preserving undefined and special numbers.
 * Functions, accessors, class instances and cycles cannot cross this boundary.
 */
export function browserLiteral(value: unknown, ancestors = new Set<object>()): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (typeof value !== "object") throw new TypeError("Browser arguments must be serializable data");
  if (ancestors.has(value)) throw new TypeError("Browser arguments cannot contain cycles");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Browser arguments must be plain objects or arrays");
  }
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError("Browser arguments cannot have symbol keys");
  ancestors.add(value);
  const entries = Object.entries(Object.getOwnPropertyDescriptors(value));
  for (const [, descriptor] of entries) {
    if (descriptor.get || descriptor.set) throw new TypeError("Browser arguments cannot contain accessors");
  }
  const result = Array.isArray(value)
    ? `[${Array.from({ length: value.length }, (_, index) => {
      if (!Object.hasOwn(value, index)) throw new TypeError("Browser arguments cannot contain sparse arrays");
      return browserLiteral(value[index], ancestors);
    }).join(",")}]`
    : `{${entries.filter(([, descriptor]) => descriptor.enumerable).map(([key, descriptor]) =>
      `[${JSON.stringify(key)}]:${browserLiteral(descriptor.value, ancestors)}`).join(",")}}`;
  ancestors.delete(value);
  return result;
}

/** Only this transport helper creates executable source. Callers author TypeScript. */
export function browserSource<T>(evaluation: BrowserEvaluation<T>): string {
  const { callback, args } = typeof evaluation === "function" ? { callback: evaluation, args: [] } : evaluation;
  return `(${callback.toString()})(...${browserLiteral(args)})`;
}
