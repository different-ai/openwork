import type { ReadToolPart, WriteToolPart } from "@/lib/build-in-tools"
import { parseFilename } from "@/components/tools/path"

interface ReadFileToolProps {
  part: ReadToolPart
}

export function ReadFileTool({ part }: ReadFileToolProps) {
  const filename = parseFilename(part.input.filePath);

  if (part.state === "output-error") {
    return (
      <div>
        <span className="text-muted-foreground">Read attempted {filename}</span> 
      </div>
    )
  }

  if (part.state !== "output-available") {
    return null;
  }

  const output = parseReadOutput(part.output);

  if (output.type === "directory") {
    return (
      <div>
        <span className="text-muted-foreground">Listing {filename}</span>
      </div>
    )
  }

  return (
    <div>
      <span className="text-muted-foreground">Read {filename}</span>
      {output.lineRange && output.truncated ? (
        <>
          {" "}
          <span className="text-muted-foreground">L{output.lineRange.firstLine}-{output.lineRange.lastLine}</span>
        </>
      ) : null}
    </div>
  )
}

interface WriteFileToolProps {
  part: WriteToolPart
}

export function WriteFileTool({ part }: WriteFileToolProps) {
  const filename = parseFilename(part.input.filePath);

  if (part.state === "output-error") {
    return (
      <div>
        <span className="text-muted-foreground">Write attempted {filename}</span> 
      </div>
    )
  }

  if (part.state !== "output-available") {
    return null;
  }

  return (
    <div>
      <span className="text-muted-foreground">Write {filename}</span> 
    </div>
  )
}

interface ReadLine {
  number: number
  text: string
}

interface ReadLineRange {
  firstLine: number
  lastLine: number
  totalLines?: number
}

interface ParsedReadFileOutput {
  type: "file"
  lines: ReadLine[]
  lineRange?: ReadLineRange
  truncated: boolean
}

interface ParsedReadDirectoryOutput {
  type: "directory"
  entries: string[]
  truncated: boolean
}

type ParsedReadOutput = ParsedReadFileOutput | ParsedReadDirectoryOutput

const END_OF_FILE_PATTERN = /^\(End of file - total (\d+) lines\)$/
const OUTPUT_CAPPED_PATTERN = /^\(Output capped at 50 KB\. Showing lines (\d+)-(\d+)\. Use offset=(\d+) to continue\.\)$/
const PARTIAL_FILE_PATTERN = /^\(Showing lines (\d+)-(\d+) of (\d+)\. Use offset=(\d+) to continue\.\)$/
const DIRECTORY_COUNT_PATTERN = /^\((\d+) entries\)$/
const DIRECTORY_TRUNCATED_PATTERN = /^\(Showing (\d+) of (\d+) entries\. Use 'offset' parameter to read beyond entry (\d+)\)$/
const LINE_PATTERN = /^(\d+): ?(.*)$/

function parseReadOutput(output: string): ParsedReadOutput {
  const type = extractTag(output, "type")

  if (type === "directory") {
    const entries = extractTag(output, "entries")
    const parsedEntries = parseReadEntries(entries)

    return {
      type: "directory",
      entries: parsedEntries.entries,
      truncated: parsedEntries.truncated,
    }
  }

  const content = extractTag(output, "content")
  const parsedContent = parseReadContent(content)

  return {
    type: "file",
    lines: parsedContent.lines,
    lineRange: parsedContent.lineRange,
    truncated: parsedContent.truncated,
  }
}

function parseReadContent(content: string | undefined) {
  const lines: ReadLine[] = []
  let lineCount: number | undefined
  let lineRange: ReadLineRange | undefined
  let truncated = false

  for (const rawLine of splitLines(content ?? "")) {
    const lineMatch = rawLine.match(LINE_PATTERN)
    if (lineMatch) {
      lines.push({
        number: Number(lineMatch[1]),
        text: lineMatch[2] ?? "",
      })
      continue
    }

    const endMatch = rawLine.match(END_OF_FILE_PATTERN)
    if (endMatch) {
      lineCount = Number(endMatch[1])
      continue
    }

    const cappedMatch = rawLine.match(OUTPUT_CAPPED_PATTERN)
    if (cappedMatch) {
      truncated = true
      lineRange = {
        firstLine: Number(cappedMatch[1]),
        lastLine: Number(cappedMatch[2]),
      }
      continue
    }

    const partialMatch = rawLine.match(PARTIAL_FILE_PATTERN)
    if (partialMatch) {
      truncated = true
      lineRange = {
        firstLine: Number(partialMatch[1]),
        lastLine: Number(partialMatch[2]),
        totalLines: Number(partialMatch[3]),
      }
    }
  }

  return {
    lines,
    lineRange: lineRange ?? getLineRange(lines, lineCount),
    truncated,
  }
}

function parseReadEntries(entriesBlock: string | undefined) {
  const entries: string[] = []
  let truncated = false

  for (const rawLine of splitLines(entriesBlock ?? "")) {
    const line = rawLine.trim()
    if (!line) {
      continue
    }

    const countMatch = line.match(DIRECTORY_COUNT_PATTERN)
    if (countMatch) {
      continue
    }

    const truncatedMatch = line.match(DIRECTORY_TRUNCATED_PATTERN)
    if (truncatedMatch) {
      truncated = true
      continue
    }

    entries.push(rawLine)
  }

  return { entries, truncated }
}

function getLineRange(lines: ReadLine[], totalLines: number | undefined): ReadLineRange | undefined {
  const first = lines[0]
  const last = lines.at(-1)
  if (!first || !last) {
    return undefined
  }

  return {
    firstLine: first.number,
    lastLine: last.number,
    totalLines,
  }
}

function extractTag(output: string, tagName: string): string | undefined {
  const pattern = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`)
  return pattern.exec(output)?.[1]?.trim()
}

function splitLines(value: string): string[] {
  return value.split(/\r\n|\n|\r/)
}
