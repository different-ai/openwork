/** Builds a host regular expression for a program's pattern. */
export type HostRegExpConstructor = new (pattern: string, flags?: string) => RegExp

declare global {
  // The standard engine reads the same global: see patches/@opencode__codemode.
  var __openworkCodemodeRegExp: HostRegExpConstructor | undefined
}

/**
 * Makes both engines build program regular expressions with this constructor.
 * A regular expression matches synchronously, so no execution timeout can stop
 * one: a host that runs programs for many callers installs a RegExp subclass
 * that limits match time. Without one, programs use RegExp itself.
 */
export function setHostRegExp(regExp: HostRegExpConstructor | undefined): void {
  globalThis.__openworkCodemodeRegExp = regExp
}

export function hostRegExp(pattern: string, flags?: string): RegExp {
  return new (globalThis.__openworkCodemodeRegExp ?? RegExp)(pattern, flags)
}
