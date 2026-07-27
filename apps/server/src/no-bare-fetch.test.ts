import { test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
// Flags every bare `fetch` reference, not only call sites, so fallback
// expressions such as `input.fetchImpl ?? fetch` or `= fetch` cannot bypass
// the ban. Allowed contexts: member access (`globalThis.fetch`), the
// type-only `typeof fetch`, `fetch:` object/type keys, and prose where the
// word `fetch` is followed by another word.
const bareFetchPattern = /(?<![-.\w$])(?<!typeof )fetch\b(?!\s*:)(?!\s+[A-Za-z_$])/;

async function collectTypescriptFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  const files: string[] = [];
  for (const entry of sortedEntries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypescriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function relativeSrcPath(file: string): string {
  return relative(srcDir, file).split(sep).join("/");
}

function shouldCheck(file: string): boolean {
  const path = relativeSrcPath(file);
  return !path.endsWith(".test.ts")
    && !path.endsWith(".e2e.test.ts")
    && path !== "server-fetch.ts"
    && !path.startsWith("opencode-plugins/");
}

test("server source does not use bare fetch", async () => {
  const offenders: string[] = [];
  const files = (await collectTypescriptFiles(srcDir)).filter(shouldCheck);
  for (const file of files) {
    const path = relativeSrcPath(file);
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/^\s*[*/]/.test(code)) return;
      if (bareFetchPattern.test(code)) offenders.push(`${path}:${index + 1}`);
    });
  }

  if (offenders.length > 0) {
    throw new Error(`Bare fetch is banned in apps/server/src. Use externalFetch for external egress, loopbackFetch for loopback/engine traffic, or runtimeDiagnosticFetch for the independent runtime diagnostic probe. Offenders:\n${offenders.join("\n")}`);
  }
});
