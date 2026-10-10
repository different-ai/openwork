/** Single-quote a value for POSIX sh. Commands sent to a sandbox run through a shell. */
export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}
