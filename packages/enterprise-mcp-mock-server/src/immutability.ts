export type DeepReadonly<Value> =
  Value extends (...arguments_: never[]) => unknown
    ? Value
    : Value extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : Value extends object
        ? { readonly [Key in keyof Value]: DeepReadonly<Value[Key]> }
        : Value

/**
 * Recursively freezes the plain data contracts exposed by this package.
 *
 * The mock server deliberately publishes immutable scenario, profile, fault,
 * snapshot, and trace values. TypeScript's `readonly` is compile-time only;
 * freezing the runtime value prevents a JavaScript consumer from silently
 * changing active server state or shared catalog fixtures.
 */
export function deepFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value

  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}
