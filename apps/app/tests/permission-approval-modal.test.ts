import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingPermission } from "../src/app/types";

import {
  PermissionApprovalPanel,
  permissionDetailRows,
} from "../src/react-app/domains/session/chat/permission-approval-modal";

function pendingPermission(overrides: Partial<PendingPermission> = {}): PendingPermission {
  return {
    id: "permission-1",
    sessionID: "session-1",
    permission: "bash",
    patterns: ["rm -rf dist"],
    metadata: {},
    always: {
      session: false,
      project: false,
    },
    receivedAt: 1,
    protocol: "legacy",
    ...overrides,
  };
}

describe("permission approval modal helpers", () => {
  test("surfaces risk-bearing metadata as review rows", () => {
    expect(
      permissionDetailRows({
        command: "rm -rf dist",
        description: "Remove build output",
        cwd: "/workspace/project",
        filepath: "/workspace/project/src/app.ts",
        diff: "-old\n+new",
        output: "not shown before approval",
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Command", "rm -rf dist"],
      ["Description", "Remove build output"],
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

  test("summarizes apply-patch file metadata", () => {
    expect(
      permissionDetailRows({
        files: [
          { type: "add", relativePath: "src/new.ts" },
          { type: "delete", filePath: "/workspace/project/src/old.ts" },
          { type: "", path: "src/update.ts" },
        ],
      }).map((row) => [row.label, row.value]),
    ).toEqual([
      ["Files", "add: src/new.ts\ndelete: /workspace/project/src/old.ts\nchange: src/update.ts"],
    ]);
  });

  test("keeps keyboard order on the safer one-shot approval before session approval", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission(),
        respondPermission: () => {},
      }),
    );

    const buttonLabels = Array.from(html.matchAll(/<button\b[\s\S]*?<\/button>/g)).map((match) =>
      match[0].replace(/<[^>]*>/g, "").trim(),
    );

    expect(buttonLabels).toEqual(["Deny", "Allow once", "Allow for session"]);
  });

  test("uses readable labels for generic permission titles", () => {
    const html = renderToStaticMarkup(
      React.createElement(PermissionApprovalPanel, {
        permission: pendingPermission({ permission: "todowrite" }),
        respondPermission: () => {},
      }),
    );

    expect(html).toContain("Approve Todo write?");
    expect(html).not.toContain("Approve todowrite?");
  });
});
