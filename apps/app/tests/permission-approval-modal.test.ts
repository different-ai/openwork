import { describe, expect, test } from "bun:test";

import { permissionDetailRows } from "../src/react-app/domains/session/chat/permission-approval-modal";

describe("permission approval modal helpers", () => {
  test("surfaces risk-bearing metadata as review rows", () => {
    expect(
      permissionDetailRows({
        command: "rm -rf dist",
        cwd: "/workspace/project",
        filepath: "/workspace/project/src/app.ts",
        diff: "-old\n+new",
        output: "not shown before approval",
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Command", "rm -rf dist"],
      ["Working directory", "/workspace/project"],
      ["File", "/workspace/project/src/app.ts"],
      ["Diff", "-old\n+new"],
    ]);
  });

  test("deduplicates alternate file metadata keys", () => {
    expect(
      permissionDetailRows({
        filepath: "/workspace/project/a.ts",
        filePath: "/workspace/project/b.ts",
      }).map((row) => [row.label, row.value]),
    ).toEqual([["File", "/workspace/project/a.ts"]]);
  });
});
