import type { Io } from "./io.ts"

export type Cell = string | number | boolean | null | undefined

export function table(headers: string[], rows: Cell[][]): string {
  const text = rows.map((row) => row.map((cell) => (cell === null || cell === undefined || cell === "" ? "-" : String(cell))))
  const widths = headers.map((header, index) => Math.max(header.length, ...text.map((row) => row[index]?.length ?? 0)))
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd()
  return [line(headers), ...text.map(line)].join("\n")
}

/** A command's result goes to stdout: JSON for scripts and agents, readable text for a person at a terminal. */
export function emit(io: Io, json: boolean, data: unknown, readable: string): void {
  io.out(json ? JSON.stringify(data, null, 2) : readable)
}
