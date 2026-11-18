import { expect, test } from "vitest";
import { addInitScript } from "./cdp.ts";
import type { CdpClient } from "./cdp.ts";

function fixture(options: { addError?: Error; removeError?: Error; result?: unknown } = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const client: CdpClient = {
    close() {},
    async send(method, params) {
      calls.push({ method, params });
      if (method === "Page.addScriptToEvaluateOnNewDocument") {
        if (options.addError) throw options.addError;
        return options.result ?? { identifier: "seed-session" };
      }
      if (options.removeError) throw options.removeError;
      return {};
    },
  };
  return { client, calls };
}

test("init script disposal removes the returned identifier once", async () => {
  const { client, calls } = fixture();
  const script = await addInitScript(client, () => undefined);
  await script.dispose();
  await script[Symbol.asyncDispose]();
  expect(calls.map(call => call.method)).toEqual(["Page.addScriptToEvaluateOnNewDocument", "Page.removeScriptToEvaluateOnNewDocument"]);
  expect(calls[1]?.params).toEqual({ identifier: "seed-session" });
});

test("a script already lost during navigation is idempotently disposed", async () => {
  const { client, calls } = fixture({ removeError: new Error("Script not found") });
  const script = await addInitScript(client, () => undefined);
  await script[Symbol.asyncDispose]();
  await script.dispose();
  expect(calls.filter(call => call.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(1);
});

test("other init script cleanup failures propagate and can be retried", async () => {
  for (const message of ["CDP websocket closed.", "Permission denied", "Script not found: transport unavailable"]) {
    const failure = new Error(message);
    const { client, calls } = fixture({ removeError: failure });
    const script = await addInitScript(client, () => undefined);
    await expect(script.dispose()).rejects.toBe(failure);
    await expect(script.dispose()).rejects.toBe(failure);
    expect(calls.filter(call => call.method === "Page.removeScriptToEvaluateOnNewDocument")).toHaveLength(2);
  }
});

test("init script installation failures are not mistaken for disposal", async () => {
  const failure = new Error("Script not found");
  const { client, calls } = fixture({ addError: failure });
  await expect(addInitScript(client, () => undefined)).rejects.toBe(failure);
  expect(calls.map(call => call.method)).toEqual(["Page.addScriptToEvaluateOnNewDocument"]);
});

test("a malformed installation result fails without attempting removal", async () => {
  const { client, calls } = fixture({ result: {} });
  await expect(addInitScript(client, () => undefined)).rejects.toThrow("CDP did not return an init script identifier");
  expect(calls).toHaveLength(1);
});
