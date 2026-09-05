import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createRendererCrashRecovery,
  installSocketTypeOfServiceGuard,
  isHarmlessSocketTypeOfServiceError,
  runDetachedTask,
} from "./process-resilience.mjs";

function socketError(code, syscall = "setTypeOfService") {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall });
}

describe("desktop process resilience", () => {
  it("matches only the known harmless macOS socket-option failure", () => {
    assert.equal(isHarmlessSocketTypeOfServiceError(socketError("EINVAL")), true);
    assert.equal(isHarmlessSocketTypeOfServiceError(socketError("EACCES")), false);
    assert.equal(isHarmlessSocketTypeOfServiceError(socketError("EINVAL", "connect")), false);
    assert.equal(isHarmlessSocketTypeOfServiceError(new Error("setTypeOfService EINVAL")), false);
  });

  it("keeps the socket usable after setTypeOfService EINVAL", () => {
    const warnings = [];
    class FakeSocket {
      setTypeOfService(_value) {
        throw socketError("EINVAL");
      }
    }

    assert.equal(installSocketTypeOfServiceGuard({
      SocketClass: FakeSocket,
      warn: (message, error) => warnings.push({ message, error }),
    }), true);
    const socket = new FakeSocket();
    assert.equal(socket.setTypeOfService(0), socket);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].message, /traffic-class/);
  });

  it("still throws unrelated socket errors", () => {
    class FakeSocket {
      setTypeOfService(_value) {
        throw socketError("EACCES");
      }
    }

    installSocketTypeOfServiceGuard({ SocketClass: FakeSocket, warn: () => undefined });
    assert.throws(() => new FakeSocket().setTypeOfService(0), { code: "EACCES" });
  });

  it("installs once per socket class", () => {
    class FakeSocket {
      setTypeOfService(_value) {
        return this;
      }
    }

    assert.equal(installSocketTypeOfServiceGuard({ SocketClass: FakeSocket }), true);
    assert.equal(installSocketTypeOfServiceGuard({ SocketClass: FakeSocket }), false);
  });

  it("reports rejected detached tasks without creating an unhandled rejection", async () => {
    const reports = [];
    runDetachedTask("menu action", async () => {
      throw new Error("window unavailable");
    }, (message, error) => reports.push({ message, error }));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /menu action failed/);
    assert.match(reports[0].error.message, /window unavailable/);
  });

  it("reloads one renderer crash and stops a rapid crash loop", async () => {
    const reloads = [];
    const reports = [];
    const repeats = [];
    let currentTime = 1_000;
    const recover = createRendererCrashRecovery({
      reload: () => reloads.push(currentTime),
      report: (message, details) => reports.push({ message, details }),
      onRepeatedCrash: (details) => repeats.push(details),
      now: () => currentTime,
    });

    assert.equal(recover({ reason: "crashed" }), true);
    await new Promise((resolve) => setImmediate(resolve));
    currentTime += 1_000;
    assert.equal(recover({ reason: "oom" }), false);
    currentTime += 31_000;
    assert.equal(recover({ reason: "crashed" }), true);
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(reloads, [1_000, 33_000]);
    assert.equal(reports.length, 3);
    assert.deepEqual(repeats, [{ reason: "oom" }]);
  });

  it("ignores a clean renderer exit", () => {
    const recover = createRendererCrashRecovery({ reload: () => assert.fail("must not reload") });
    assert.equal(recover({ reason: "clean-exit" }), false);
  });
});
