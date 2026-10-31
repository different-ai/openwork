import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpenWithApplications, installedApplicationCommand } from "./open-with-applications.mjs";

test("unlisted renderer executables are rejected even for a valid workspace file", () => {
  const choices = createOpenWithApplications();
  const file = "/workspace/example.sh";
  assert.equal(choices.allows(1, file, "/bin/sh"), false);
  choices.remember(1, file, ["/usr/share/applications/editor.desktop"]);
  assert.equal(choices.allows(1, file, "/bin/sh"), false);
  assert.equal(choices.allows(1, file, "/usr/bin/python3"), false);
  assert.equal(choices.allows(1, file, "/workspace/custom.desktop"), false);
  assert.equal(choices.allows(1, file, "/usr/share/applications/editor.desktop"), true);
});

test("installed choices are bound to the renderer and the exact canonical file", () => {
  const choices = createOpenWithApplications();
  choices.remember(1, "/workspace/a.md", ["/Applications/Editor.app"]);
  assert.equal(choices.allows(2, "/workspace/a.md", "/Applications/Editor.app"), false);
  assert.equal(choices.allows(1, "/workspace/b.md", "/Applications/Editor.app"), false);
  assert.equal(choices.allows(1, "/workspace/a.md", "/Applications/Editor.app"), true);
});

test("stale choices expire and refreshed choices replace earlier permissions", () => {
  let now = 0;
  const choices = createOpenWithApplications({ now: () => now, ttlMs: 100 });
  choices.remember(1, "/workspace/a.md", ["/Applications/Old.app"]);
  now = 100;
  assert.equal(choices.allows(1, "/workspace/a.md", "/Applications/Old.app"), false);
  choices.remember(1, "/workspace/a.md", ["/Applications/New.app"]);
  assert.equal(choices.allows(1, "/workspace/a.md", "/Applications/Old.app"), false);
  assert.equal(choices.allows(1, "/workspace/a.md", "/Applications/New.app"), true);
});

test("Linux opens an installed desktop entry via GIO, never an arbitrary executable", () => {
  assert.equal(installedApplicationCommand("linux", "/bin/sh", "/workspace/example.sh"), null);
  assert.deepEqual(installedApplicationCommand("linux", "/usr/share/applications/editor.desktop", "/workspace/example.sh"), {
    command: "gio", args: ["launch", "/usr/share/applications/editor.desktop", "/workspace/example.sh"],
  });
  assert.deepEqual(installedApplicationCommand("darwin", "/Applications/Editor.app", "/workspace/a.md"), {
    command: "open", args: ["-a", "/Applications/Editor.app", "/workspace/a.md"],
  });
});
