import assert from "node:assert/strict";
import test from "node:test";

import {
  isWithinWorkspaceRootPath,
  normalizeScopedDirectoryPath,
} from "../dist/path-scope.js";

test("normalizeScopedDirectoryPath strips Windows verbatim prefixes", () => {
  const workspaceRoot = String.raw`G:\project\openwork_project`;
  const candidate = String.raw`\\?\G:\project\openwork_project`;

  assert.equal(
    normalizeScopedDirectoryPath(workspaceRoot, "win32"),
    "g:/project/openwork_project",
  );
  assert.equal(
    normalizeScopedDirectoryPath(candidate, "win32"),
    "g:/project/openwork_project",
  );
});

test("isWithinWorkspaceRootPath accepts Windows verbatim aliases for workspace root", () => {
  const workspaceRoot = String.raw`G:\project\openwork_project`;
  const candidate = String.raw`\\?\G:\project\openwork_project`;

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
      platform: "win32",
    }),
    true,
  );
});

test("isWithinWorkspaceRootPath still rejects directories outside the workspace root", () => {
  const workspaceRoot = String.raw`G:\project\openwork_project`;
  const candidate = String.raw`\\?\G:\project\outside`;

  assert.equal(
    isWithinWorkspaceRootPath({
      workspaceRoot,
      candidate,
      platform: "win32",
    }),
    false,
  );
});
