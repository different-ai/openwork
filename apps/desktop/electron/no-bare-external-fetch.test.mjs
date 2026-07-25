import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const bareFetchPattern = /(?<![.\w])fetch\s*\(/;
const loopbackMarkerPattern = /\/\/\s*loopback-fetch:\s*\S/;

async function collectModuleFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  for (const entry of sortedEntries) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectModuleFiles(file));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      files.push(file);
    }
  }
  return files;
}

function relativeSrcPath(file) {
  return relative(srcDir, file).split(sep).join("/");
}

function shouldCheck(file) {
  return !relativeSrcPath(file).endsWith(".test.mjs");
}

function hasLoopbackMarker(lines, index) {
  return loopbackMarkerPattern.test(lines[index] ?? "") || (
    index > 0 && loopbackMarkerPattern.test(lines[index - 1] ?? "")
  );
}

test("desktop electron source does not use unmarked bare fetch", async () => {
  const offenders = [];
  const files = (await collectModuleFiles(srcDir)).filter(shouldCheck);
  for (const file of files) {
    const path = relativeSrcPath(file);
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, "");
      if (bareFetchPattern.test(code) && !hasLoopbackMarker(lines, index)) {
        offenders.push(`${path}:${index + 1}`);
      }
    });
  }

  if (offenders.length > 0) {
    throw new Error(`Unmarked bare fetch is banned in apps/desktop/electron because bare fetch bypasses Chromium's certificate trust path and system proxy; use electronNet.fetch for external requests, or add // loopback-fetch: <reason> if the target is provably 127.0.0.1/localhost. Offenders:\n${offenders.join("\n")}`);
  }
});
