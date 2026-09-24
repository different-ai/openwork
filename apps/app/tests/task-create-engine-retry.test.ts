import { describe, expect, test } from "bun:test";

import {
  describeTaskCreateFailure,
  describeTaskCreateRetry,
  TASK_CREATE_RETRY_DELAYS_MS,
  withTransientEngineRetry,
} from "../src/react-app/shell/route-workspaces";

// New task used to give up on the first 10 s timeout with a dead-end
// "OpenCode unavailable" toast even though the engine was alive and merely
// stalled (rollover, overloaded event loop). Creation now retries transient
// failures with a visible countdown and only then explains what is wrong.

function timedOut() {
  return new Error("Request timed out.");
}

describe("withTransientEngineRetry", () => {
  test("retries a timed-out engine call, reports each failed attempt, and returns the eventual result", async () => {
    let calls = 0;
    const waits: number[] = [];
    const retries: Array<{ attempt: number; message: string }> = [];

    const result = await withTransientEngineRetry({
      load: async () => {
        calls += 1;
        if (calls < 3) throw timedOut();
        return { id: "ses_created" };
      },
      retryDelaysMs: TASK_CREATE_RETRY_DELAYS_MS,
      wait: async (delayMs) => { waits.push(delayMs); },
      onRetry: (attempt, error) => {
        retries.push({ attempt, message: error instanceof Error ? error.message : String(error) });
      },
    });

    expect(result).toEqual({ id: "ses_created" });
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
    expect(retries).toEqual([
      { attempt: 1, message: "Request timed out." },
      { attempt: 2, message: "Request timed out." },
    ]);
  });

  test("gives up with the last error once every retry delay is spent", async () => {
    let calls = 0;
    const waits: number[] = [];

    await expect(withTransientEngineRetry({
      load: async () => {
        calls += 1;
        throw timedOut();
      },
      retryDelaysMs: TASK_CREATE_RETRY_DELAYS_MS,
      wait: async (delayMs) => { waits.push(delayMs); },
    })).rejects.toThrow("Request timed out.");

    expect(calls).toBe(TASK_CREATE_RETRY_DELAYS_MS.length + 1);
    expect(waits).toEqual([...TASK_CREATE_RETRY_DELAYS_MS]);
  });

  test("does not retry a terminal error and never reports a retry for it", async () => {
    let calls = 0;
    let retried = false;

    await expect(withTransientEngineRetry({
      load: async () => {
        calls += 1;
        throw new Error("Workspace path is not authorized");
      },
      retryDelaysMs: TASK_CREATE_RETRY_DELAYS_MS,
      wait: async () => { throw new Error("must not wait"); },
      onRetry: () => { retried = true; },
    })).rejects.toThrow("Workspace path is not authorized");

    expect(calls).toBe(1);
    expect(retried).toBe(false);
  });
});

describe("describeTaskCreateFailure", () => {
  test("names a stalled engine after exhausted retries instead of calling it unavailable", () => {
    const failure = describeTaskCreateFailure(timedOut(), 4);
    expect(failure.kind).toBe("not_responding");
    expect(failure.title).toBe("OpenCode is not responding");
    expect(failure.description).toBe(
      "The engine did not answer after 4 attempts. It may be restarting or overloaded.",
    );
  });

  test("treats a 503 from the desktop server as the same stalled-engine situation", () => {
    const error = Object.assign(new Error("engine starting"), { status: 503, code: "opencode_engine_unreachable" });
    expect(describeTaskCreateFailure(error, 4).kind).toBe("not_responding");
  });

  test("keeps the unavailable wording and the raw message for terminal errors", () => {
    const failure = describeTaskCreateFailure(new Error("Workspace path is not authorized"), 4);
    expect(failure.kind).toBe("unavailable");
    expect(failure.title).toBe("OpenCode unavailable");
    expect(failure.description).toBe("Workspace path is not authorized");
  });
});

describe("describeTaskCreateRetry", () => {
  test("hides engine internals when developer mode is off", () => {
    const notice = describeTaskCreateRetry({ developerMode: false, attempt: 2, attempts: 4 });
    expect(notice.title).toBe("Still loading…");
    expect(notice.description).not.toContain("OpenCode");
    expect(notice.description).not.toContain("engine");
    expect(notice.description).not.toContain("Retrying");
    expect(notice.description).not.toContain("2/4");
  });

  test("keeps the retry countdown when developer mode is on", () => {
    const notice = describeTaskCreateRetry({ developerMode: true, attempt: 2, attempts: 4 });
    expect(notice.title).toBe("OpenCode is catching up");
    expect(notice.description).toContain("Retrying (2/4)…");
  });
});
