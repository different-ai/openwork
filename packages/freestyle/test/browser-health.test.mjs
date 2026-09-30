import assert from "node:assert/strict";
import test from "node:test";
import { verifyBrowserHandoff } from "../src/browser-health.mjs";

test("browser readiness rejects a missing launcher", async () => {
  await assert.rejects(verifyBrowserHandoff({ launcher: "/missing/openwork-test-browser" }), { code: "ENOENT" });
});

test("browser readiness rejects a launcher failure without waiting for the deadline", async () => {
  await assert.rejects(verifyBrowserHandoff({ launcher: process.execPath, args: ["-e", "process.exit(4)"] }), /launcher failed/);
});

test("a successful launcher exit without rendering does not pass readiness", async () => {
  await assert.rejects(verifyBrowserHandoff({ launcher: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 500 }), /did not render/);
});
