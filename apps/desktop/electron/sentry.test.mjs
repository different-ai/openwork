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
    redactHomePath("spawn C:\\Users\\Alex\\AppData\\Local\\opencode.exe ENOENT", "C:\\Users\\Alex"),
    "spawn ~\\AppData\\Local\\opencode.exe ENOENT",
  );
  assert.equal(
    redactHomePath("open c:/users/alex/.local/share/opencode/db failed", "C:\\Users\\Alex\\"),
    "open ~/.local/share/opencode/db failed",
  );
  assert.equal(redactHomePath("/Users/ana/work and /Users/ana", "/Users/ana"), "~/work and ~");
  assert.equal(redactHomePath("nothing to hide", ""), "nothing to hide");
});

test("startup errors are reported as redacted copies", () => {
  const original = new TypeError("EACCES: permission denied, open '/home/sam/.config/openwork/x.json'");
  original.stack = `TypeError: ${original.message}\n    at boot (/home/sam/app/main.mjs:1:1)`;

  const report = startupErrorForReport(original, { home: "/home/sam" });
  assert.equal(report.name, "TypeError");
  assert.equal(report.message, "EACCES: permission denied, open '~/.config/openwork/x.json'");
  assert.ok(!report.stack.includes("/home/sam"));
  assert.equal(original.message.includes("/home/sam"), true);

  assert.equal(startupErrorForReport("plain string", { home: "/home/sam" }).message, "plain string");
});

test("workspace folders are redacted, including ones outside the home folder", () => {
  const error = new Error(
    "engine failed for D:\\Clients\\Acme Project\\notes and C:\\Users\\Alex\\Work\\site (home C:\\Users\\Alex)",
  );
  const report = startupErrorForReport(error, {
    home: "C:\\Users\\Alex",
    workspacePaths: ["D:\\Clients\\Acme Project", "C:\\Users\\Alex\\Work\\site"],
  });
  assert.equal(report.message, "engine failed for <workspace>\\notes and <workspace> (home ~)");
  assert.ok(!report.stack.includes("Acme"));
  assert.ok(!report.stack.includes("Alex"));
});

test("startup captures are a no-op while Sentry is not initialized", () => {
  assert.equal(captureStartupException(new Error("engine did not start"), { surface: "desktop-boot" }), false);
});
