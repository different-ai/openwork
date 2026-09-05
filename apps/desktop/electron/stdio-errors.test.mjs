import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { installStdioErrorHandlers, isBrokenPipeError } from "./stdio-errors.mjs";

/**
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function streamError(code) {
  return Object.assign(new Error(code === "EPIPE" ? "write EPIPE" : "stream failed"), { code });
}

describe("stdio error handling", () => {
  it("identifies broken pipe errors", () => {
    assert.equal(isBrokenPipeError(streamError("EPIPE")), true);
    assert.equal(isBrokenPipeError(streamError("ECONNRESET")), false);
    assert.equal(isBrokenPipeError(null), false);
  });

  it("swallows stdio EPIPE and preserves other stream errors", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    installStdioErrorHandlers({ stdout, stderr });

    for (const code of ["EPIPE", "ERR_STREAM_DESTROYED", "ENOSPC", "EDQUOT"]) {
      assert.doesNotThrow(() => stdout.emit("error", streamError(code)));
      assert.doesNotThrow(() => stderr.emit("error", streamError(code)));
    }
    assert.throws(() => stderr.emit("error", streamError("ECONNRESET")), /stream failed/);
  });

  it("does not install duplicate handlers on the same stream", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();

    installStdioErrorHandlers({ stdout, stderr });
    installStdioErrorHandlers({ stdout, stderr });

    assert.equal(stdout.listenerCount("error"), 1);
    assert.equal(stderr.listenerCount("error"), 1);
  });
});
