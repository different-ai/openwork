import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { before, after, test } from "node:test";

let child, base;
before(async () => {
  child = fork(new URL("./microsoft365.mjs", import.meta.url), [], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: "0", OPEN_WORKPLACE_NOW: "2026-10-16T15:55:00Z" },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const [message] = await once(child, "message", { signal: AbortSignal.timeout(10_000) });
  assert.equal(message.type, "ready");
  base = `http://127.0.0.1:${message.port}`;
});
after(async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  if (child.connected) child.disconnect();
  await exited;
});

async function graph(path, method = "GET", body) {
  const response = await fetch(`${base}/v1.0${path}`, {
    method, headers: { authorization: "Bearer open-workplace-token", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.ok, true, `Graph ${method} ${path}: HTTP ${response.status}`);
  return response.json();
}

for (const { start, end, timeZone, expectedStart, expectedEnd } of [
  { start: "2026-11-20T09:00:00.123-08:00", end: "2026-11-20T09:00:00.987-08:00", timeZone: "UTC", expectedStart: "2026-11-20T17:00:00.1230000", expectedEnd: "2026-11-20T17:00:00.9870000" },
  { start: "2026-11-20T09:00:00.007+05:30", end: "2026-11-20T10:00:00.040+05:30", timeZone: "Asia/Kolkata", expectedStart: "2026-11-20T09:00:00.0070000", expectedEnd: "2026-11-20T10:00:00.0400000" },
  { start: "2026-11-20T09:00:00.456Z", end: "2026-11-20T10:00:00.789Z", timeZone: "Pacific Standard Time", expectedStart: "2026-11-20T01:00:00.4560000", expectedEnd: "2026-11-20T02:00:00.7890000" },
  { start: "1969-12-31T23:59:58.789Z", end: "1969-12-31T23:59:59.012Z", timeZone: "UTC", expectedStart: "1969-12-31T23:59:58.7890000", expectedEnd: "1969-12-31T23:59:59.0120000" },
  { start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z", timeZone: "UTC", expectedStart: "2026-11-20T09:00:00.0000000", expectedEnd: "2026-11-20T10:00:00.0000000" },
]) {
  test(`Graph create and read preserve milliseconds for ${start} in ${timeZone}`, async () => {
    const event = await graph("/me/events", "POST", {
      subject: "Fractional-second regression",
      start: { dateTime: start, timeZone }, end: { dateTime: end, timeZone },
    });
    assert.deepEqual(event.start, { dateTime: expectedStart, timeZone });
    assert.deepEqual(event.end, { dateTime: expectedEnd, timeZone });
    const read = await graph(`/me/events/${event.id}`);
    assert.deepEqual(read.start, event.start);
    assert.deepEqual(read.end, event.end);
  });
}

test("calendar range filtering and updates retain sub-second event boundaries", async () => {
  const event = await graph("/me/events", "POST", {
    subject: "Sub-second range regression",
    start: { dateTime: "2026-11-21T09:00:00.123-08:00", timeZone: "UTC" },
    end: { dateTime: "2026-11-21T09:00:00.987-08:00", timeZone: "UTC" },
  });
  const range = new URLSearchParams({ startDateTime: "2026-11-21T17:00:00.500Z", endDateTime: "2026-11-21T17:00:00.800Z" });
  const list = await graph(`/me/calendarView?${range}`);
  assert.equal(list.value.some((entry) => entry.id === event.id), true);
  const updated = await graph(`/me/events/${event.id}`, "PATCH", {
    start: { dateTime: "2026-11-21T09:00:00.222-08:00", timeZone: "UTC" },
    end: { dateTime: "2026-11-21T09:00:00.999-08:00", timeZone: "UTC" },
  });
  assert.equal(updated.start.dateTime, "2026-11-21T17:00:00.2220000");
  assert.equal(updated.end.dateTime, "2026-11-21T17:00:00.9990000");
});

test("local wall times preserve their supplied fractional-second precision", async () => {
  const start = { dateTime: "2026-11-22T09:00:00.1234567", timeZone: "UTC" };
  const end = { dateTime: "2026-11-22T10:00:00.7654321", timeZone: "UTC" };
  const event = await graph("/me/events", "POST", { subject: "Local wall time", start, end });
  assert.deepEqual(event.start, start);
  assert.deepEqual(event.end, end);
});
