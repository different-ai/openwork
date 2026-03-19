import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";
import { dirname } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { ApiError } from "./errors.js";
import { ensureDir, exists } from "./utils.js";

interface ParseResult<T> {
  data: T;
  raw: string;
}

export async function readJsoncFile<T>(path: string, fallback: T): Promise<ParseResult<T>> {
  if (!(await exists(path))) {
    return { data: fallback, raw: "" };
  }
  const raw = await readFile(path, "utf8");
  const errors: { error: number; offset: number; length: number }[] = [];
  const data = parse(raw, errors, { allowTrailingComma: true }) as T;
  if (errors.length > 0) {
    const details = errors.map((error) => ({
      code: printParseErrorCode(error.error),
      offset: error.offset,
      length: error.length,
    }));
    throw new ApiError(422, "invalid_jsonc", "Failed to parse JSONC", details);
  }
  return { data, raw };
}

export async function updateJsoncTopLevel(path: string, updates: Record<string, unknown>): Promise<void> {
  const hasFile = await exists(path);
  if (!hasFile) {
    await ensureDir(dirname(path));
    const content = JSON.stringify(updates, null, 2) + "\n";
    await writeFile(path, content, "utf8");
    return;
  }

  let content = await readFile(path, "utf8");
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
  for (const [key, value] of Object.entries(updates)) {
    const edits = modify(content, [key], value, { formattingOptions });
    content = applyEdits(content, edits);
  }
  await writeFile(path, content.endsWith("\n") ? content : content + "\n", "utf8");
}

export async function writeJsoncFile(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  const content = JSON.stringify(value, null, 2) + "\n";
  await writeFile(path, content, "utf8");
}
