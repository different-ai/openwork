import { expect, test, vi } from "vitest";
import { refusal } from "@openwork/computers";
import type { ComputerExecution } from "@openwork/types/den/computers";
import { createComputersDen } from "../src/computers/den.js";
import { computerExecutor, type ComputerExecutorRequest } from "../src/computers/executors/index.js";

const request = (): ComputerExecutorRequest => ({ id: "travel", label: "Travel MacBook", signal: new AbortController().signal, call: { tool: "shell", input: { command: "pwd", cwd: "/workspace" } } });
const running = (): ComputerExecution => ({ state: "running", id: "command", expiresAt: new Date(Date.now() + 30_000).toISOString() });
const done: ComputerExecution = { state: "done", id: "command", exitCode: 2, output: "result text", truncated: true };
const lostContact = "OpenWork lost contact while sending work to Travel MacBook. It may still run there. Check that computer before running it again.";
const nothingRan = "OpenWork couldn't reach Travel MacBook. Nothing ran there.";
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
  await expect(result).rejects.toThrow(stage === "before" ? "Nothing ran there." : stage === "enqueue" ? lostContact : stage === "after" ? "stopped waiting" : "doesn't know how the operation ended");
  expect(enqueue).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
  expect(follow).toHaveBeenCalledTimes(stage === "follow" || stage === "after" ? 1 : 0);
});

const credential = { baseUrl: "https://den.example.test/api/den", token: "fixture-runner" };
const runQueued = (queue: ReturnType<ReturnType<typeof createComputersDen>["sourceQueue"]>, signal = new AbortController().signal) =>
  computerExecutor("openwork_desktop").run({ ...request(), signal }, { queue });
const transportError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error("fixture failure"), { code }) });

test.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"])("a connect failure (%s) confirms nothing ran and never retries", async code => {
  const fetch = vi.fn(async () => { throw transportError(code); });
  const queue = createComputersDen(() => null, { runnerCredential: () => credential, fetch }).sourceQueue();
  await expect(runQueued(queue)).rejects.toThrow(nothingRan);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { name: "a normal 4xx", reply: () => Response.json({ error: "denied" }, { status: 403 }), message: nothingRan },
  { name: "computer_not_found", reply: () => Response.json({ error: "computer_not_found" }, { status: 404 }), message: nothingRan },
  { name: "an unreadable 4xx", reply: () => new Response("Not JSON", { status: 429 }), message: nothingRan },
  { name: "a timeout", reply: () => { throw new DOMException("The answer timed out", "TimeoutError"); }, message: lostContact },
  { name: "a socket reset", reply: () => { throw transportError("ECONNRESET"); }, message: lostContact },
  { name: "a 5xx", reply: () => Response.json({ error: "internal" }, { status: 503 }), message: lostContact },
  { name: "invalid JSON", reply: () => new Response("Not JSON"), message: lostContact },
  { name: "an invalid success body", reply: () => Response.json({ unexpected: true }), message: lostContact },
])("reports the correct outcome on $name and never retries", async ({ reply, message }) => {
  const fetch = vi.fn(async () => reply());
  const queue = createComputersDen(() => null, { runnerCredential: () => credential, fetch }).sourceQueue();
  await expect(runQueued(queue)).rejects.toThrow(message);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("an identity change or cancellation before sending never contacts Den", async () => {
  let signedIn = true;
  const fetch = vi.fn(async () => Response.json(done));
  const queue = createComputersDen(() => null, { runnerCredential: () => signedIn ? credential : null, fetch }).sourceQueue();
  const controller = new AbortController();
  controller.abort();
  await expect(runQueued(queue, controller.signal)).rejects.toThrow(nothingRan);
  await expect(queue?.enqueue("travel", request().call, controller.signal)).rejects.toMatchObject({ mayHaveQueued: false });
  signedIn = false;
  await expect(runQueued(queue)).rejects.toThrow(nothingRan);
  expect(fetch).not.toHaveBeenCalled();
});

test("cancelling while Den has the request is unknown, not a clean refusal", async () => {
  const controller = new AbortController();
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    controller.abort();
    init?.signal?.throwIfAborted();
    throw new Error("Expected the request signal to be cancelled");
  });
  const queue = createComputersDen(() => null, { runnerCredential: () => credential, fetch }).sourceQueue();
  await expect(runQueued(queue, controller.signal)).rejects.toThrow(lostContact);
  expect(fetch).toHaveBeenCalledExactlyOnceWith(`${credential.baseUrl}/v1/computer-sources/computers/travel/commands`, expect.objectContaining({ method: "POST", body: JSON.stringify({ call: request().call, waitMs: 0 }) }));
});

test("doesn't try a provider when the machine has no executor or isn't connected to Den", async () => {
  await expect(computerExecutor("other").run(request(), {})).rejects.toThrow("can't take work from other computers yet.");
  await expect(computerExecutor("openwork_desktop").run(request(), {})).rejects.toThrow("hasn't finished connecting to your organization yet.");
});
