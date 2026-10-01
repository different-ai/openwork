import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const sourceRoot = join(import.meta.dir, "..", "src");
const guidance = "Use a @/components/ui floating primitive (Popover, DropdownMenu, ContextMenu, Select, Tooltip, HoverCard); see DESIGN.md S7";

// Outside-press listeners that are not floating surfaces, with the reason.
const outsidePressAllowed = new Map([
  ["react-app/domains/session/chat/session-empty-hero.tsx", "ends mobile composition when the person leaves the composer dock"],
]);

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if ((entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) && !entry.name.endsWith(".d.ts")) {
      files.push(path);
    }
  }
  return files;
}

// The primitives wrap Base UI; everything else composes them.
const files = sourceFiles(sourceRoot)
  .map((path) => ({ relativePath: relative(sourceRoot, path).split(sep).join("/"), lines: readFileSync(path, "utf8").split("\n") }))
  .filter((file) => !file.relativePath.startsWith("components/ui/"));

function offenders(matches: (line: string) => boolean) {
  return files.flatMap((file) => file.lines.flatMap((line, index) => (matches(line) ? [`${file.relativePath}:${index + 1}`] : [])));
}

describe("floating surface guard", () => {
  test("no panel is hand-positioned against its trigger", () => {
    const handPositioned = offenders((line) => /\babsolute\b/.test(line) && /\b(?:top|bottom)-(?:full\b|\[calc\(100%)/.test(line));
    expect(handPositioned, guidance).toEqual([]);
  });

  test("no surface closes itself with a document or window outside-press listener", () => {
    const listeners = offenders((line) => /\b(?:document|window)\.addEventListener\(\s*["'](?:mousedown|pointerdown|click|touchstart)["']/.test(line))
      .filter((location) => !outsidePressAllowed.has(location.slice(0, location.lastIndexOf(":"))));
    expect(listeners, guidance).toEqual([]);
  });
});
