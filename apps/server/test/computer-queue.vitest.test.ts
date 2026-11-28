import { expect, test, vi } from "vitest";
import { refusal } from "@openwork/computers";
import type { ComputerExecution } from "@openwork/types/den/computers";
import { computerExecutor, type ComputerExecutorRequest } from "../src/computers/executors/index.js";

const request = (): ComputerExecutorRequest => ({ id: "travel", label: "Travel MacBook", signal: new AbortController().signal, call: { tool: "shell", input: { command: "pwd", cwd: "/workspace" } } });
const running = (): ComputerExecution => ({ state: "running", id: "command", expiresAt: new Date(Date.now() + 30_000).toISOString() });
const done: ComputerExecution = { state: "done", id: "command", exitCode: 2, output: "result text", truncated: true };
const cases: [ComputerExecution, string][] = [
  [{ ...refusal("source_not_allowed", { label: "Travel MacBook" }), state: "refused" }, "doesn't take work from this computer"],
  [{ state: "offline", message: "The computer is asleep.", retryable: true, lastSeenAt: null }, "asleep"],
  [{ state: "unsupported", message: "Reach this computer directly." }, "directly"],
  [{ state: "failed", id: "command", error: { code: "not_picked_up", message: "Nothing ran there." } }, "Nothing ran there."],
  [{ state: "unknown", id: "command", message: "Check before running again." }, "Check before running again."],
];

test.each(cases)("returns the Den wording for $state", async (decision, message) => {
  const follow = vi.fn(async () => done);
  await expect(computerExecutor("openwork_desktop").run(request(), { queue: { enqueue: async () => decision, follow } })).rejects.toThrow(message);
  expect(follow).not.toHaveBeenCalled();
});

test("enqueues once, follows running responses until done, and maps output", async () => {
  const enqueue = vi.fn(async () => running());
  const follow = vi.fn(async () => done).mockResolvedValueOnce(running());
  const call = request();
  expect(await computerExecutor("openwork_desktop").run(call, { queue: { enqueue, follow } })).toEqual({ content: [{ type: "text", text: "result text" }], metadata: { sandbox: true, truncated: true, exitCode: 2 } });
  expect(enqueue).toHaveBeenCalledExactlyOnceWith(call.id, call.call, call.signal);
  expect(follow).toHaveBeenCalledTimes(2);
  expect(follow).toHaveBeenCalledWith("command", expect.any(AbortSignal));
});

test.each(["before", "enqueue", "follow", "after", "expired"])("reports loss at %s without replay", async stage => {
  const controller = new AbortController();
  if (stage === "before") controller.abort();
  const enqueue = vi.fn(async (): Promise<ComputerExecution> => {
    if (stage === "enqueue") throw new Error("Network disconnected");
    if (stage === "expired") return { ...running(), expiresAt: new Date(Date.now() - 16_000).toISOString() };
    return running();
  });
  const follow = vi.fn(async () => {
    if (stage === "after") controller.abort();
    throw new Error("Network disconnected");
  });
  const result = computerExecutor("openwork_desktop").run({ ...request(), signal: controller.signal }, { queue: { enqueue, follow } });
  await expect(result).rejects.toThrow(stage === "before" || stage === "enqueue" ? "Nothing ran there." : stage === "after" ? "stopped waiting" : "doesn't know how the operation ended");
  expect(enqueue).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  expect(follow).toHaveBeenCalledTimes(stage === "follow" || stage === "after" ? 1 : 0);
});

test("doesn't try a provider when the machine has no executor or isn't connected to Den", async () => {
  await expect(computerExecutor("other").run(request(), {})).rejects.toThrow("can't take work from other computers yet.");
  await expect(computerExecutor("openwork_desktop").run(request(), {})).rejects.toThrow("hasn't finished connecting to your organization yet.");
});
