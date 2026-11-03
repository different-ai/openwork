import assert from "node:assert/strict";
import test from "node:test";

import {
  captureStartupException,
  createPendingCaptureQueue,
  redactHomePath,
  startupErrorForReport,
} from "./sentry.mjs";

test("pending startup captures keep the newest few and drain once", () => {
  const queue = createPendingCaptureQueue({ max: 2 });
  queue.add(new Error("first"), { surface: "desktop-boot" });
  queue.add(new Error("second"), { surface: "desktop-boot" });
  queue.add(new Error("third"), { surface: "desktop-boot" });

  const drained = queue.drain();
  assert.deepEqual(drained.map((entry) => entry.error.message), ["second", "third"]);
  assert.equal(drained[0].context.surface, "desktop-boot");
  assert.equal(queue.size(), 0);
  assert.deepEqual(queue.drain(), []);
});

test("home folder paths are redacted on Windows and POSIX", () => {
  assert.equal(
    redactHomePath("spawn C:\\Users\\Flavio\\AppData\\Local\\opencode.exe ENOENT", "C:\\Users\\Flavio"),
    "spawn ~\\AppData\\Local\\opencode.exe ENOENT",
  );
  assert.equal(
    redactHomePath("open c:/users/flavio/.local/share/opencode/db failed", "C:\\Users\\Flavio\\"),
    "open ~/.local/share/opencode/db failed",
  );
  assert.equal(redactHomePath("/Users/ana/work and /Users/ana", "/Users/ana"), "~/work and ~");
  assert.equal(redactHomePath("nothing to hide", ""), "nothing to hide");
});

test("startup errors are reported as redacted copies", () => {
  const original = new TypeError("EACCES: permission denied, open '/home/sam/.config/openwork/x.json'");
  original.stack = `TypeError: ${original.message}\n    at boot (/home/sam/app/main.mjs:1:1)`;

  const report = startupErrorForReport(original, "/home/sam");
  assert.equal(report.name, "TypeError");
  assert.equal(report.message, "EACCES: permission denied, open '~/.config/openwork/x.json'");
  assert.ok(!report.stack.includes("/home/sam"));
  assert.equal(original.message.includes("/home/sam"), true);

  assert.equal(startupErrorForReport("plain string", "/home/sam").message, "plain string");
});

test("startup captures are a no-op while Sentry is not initialized", () => {
  assert.equal(captureStartupException(new Error("engine did not start"), { surface: "desktop-boot" }), false);
});
