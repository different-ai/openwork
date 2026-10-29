import assert from "node:assert/strict";
import { test } from "node:test";
import { attendeeKey, bootAttendees, parseWorkshopOptions, validateSandboxInfo, validatePilotRead, workshopBudget, workshopAccountPassword } from "./workshop-fleet.ts";
import { workshopBrowserInstaller, workshopRemoteScript, WORKSHOP_ALLOW_LABEL, WORKSHOP_GUEST_PATTERN, WORKSHOP_BROWSER_PROFILE, WORKSHOP_BROWSER_LAUNCHER } from "./lib/workshop-browser.ts";
import { execFileSync } from "node:child_process";

test("remote browser scripts survive the execInSandbox single-quote transport", () => {
  for (const script of [workshopBrowserInstaller(), "printf '%s' \"owner's browser\""]) {
    const remote = workshopRemoteScript(script);
    assert.ok(!remote.includes("'"));
    const encoded = remote.split(" ")[2];
    assert.equal(Buffer.from(encoded, "base64").toString(), script);
    execFileSync("bash", ["-n"], { input: script });
  }
  assert.equal(execFileSync("bash", ["-lc", workshopRemoteScript("printf '%s' \"owner's browser\"")], { encoding: "utf8" }), "owner's browser");
});

test("timed fleet fan-out supports five bounded workers only after the pilot", async () => {
  let active = 0, max = 0, pilot = false;
  const result = await bootAttendees(20, async (index) => {
    if (index === 1) { pilot = true; return index; }
    assert.ok(pilot); active += 1; max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1; return index;
  }, 5);
  assert.equal(max, 5); assert.equal(result.length, 20);
  await assert.rejects(bootAttendees(20, async (index) => index, 6));
});

test("consent matcher recognizes the actual hosted workplace native Allow button, never Deny", () => {
  assert.match("Allow workplace access", new RegExp(WORKSHOP_ALLOW_LABEL, "i"));
  assert.doesNotMatch("Deny access", new RegExp(WORKSHOP_ALLOW_LABEL, "i"));
});

test("guest identity comes from the real account tooltip or accessible name, not avatar initials or Graph me.id", () => {
  const pattern = new RegExp(WORKSHOP_GUEST_PATTERN, "i");
  assert.equal("Workshop guest 212 · guest-abc@acme.test".match(pattern)?.[1], "212");
  assert.equal("Workshop guest 213".match(pattern)?.[1], "213");
  assert.doesNotMatch("WG", pattern);
  assert.doesNotMatch("workshop-guest-", pattern);
});

const output = "/private/var/workshop-fleet-fixture";
test("generated account passwords fit Den's maximum without sharing credentials", () => {
  const values = Array.from({ length: 21 }, workshopAccountPassword);
  assert.equal(new Set(values).size, 21);
  for (const value of values) {
    assert.ok(value.length >= 12 && value.length <= 32);
    for (const required of [/[A-Z]/, /[a-z]/, /[0-9]/, /[!]/]) assert.match(value, required);
  }
});
test("pilot is the default; lifetime and exact source are explicit and bounded", () => {
  assert.deepEqual(parseWorkshopOptions(["--output-dir", output]), { count: 1, lifetimeMinutes: 1440, outputDir: output, ref: undefined });
  const ref = "a".repeat(40);
  assert.equal(parseWorkshopOptions(["--count", "20", "--ref", ref, "--output-dir", output, "--lifetime", "60"]).ref, ref);
  assert.throws(() => parseWorkshopOptions([]));
  for (const args of [["--count", "2"], ["--count", "21"], ["--lifetime", "0"], ["--lifetime", "1441"], ["--lifetime", "2.5"], ["--ref", "dev"], ["--ref", "abcdef0"], ["--output-dir", "relative"], ["--output-dir", process.cwd()], ["--count", "1", "--count", "20"], ["--unknown", "yes"]]) {
    assert.throws(() => parseWorkshopOptions([...args, "--output-dir", output]));
  }
});

test("twenty stable ordinary attendee names; no admin seat", () => {
  const keys = Array.from({ length: 20 }, (_, index) => attendeeKey(index + 1));
  assert.equal(new Set(keys).size, 20);
  assert.equal(keys[0], "attendee01"); assert.equal(keys.at(-1), "attendee20");
  assert.ok(keys.every((key) => !/admin|owner|host/.test(key)));
  for (const index of [0, 21, -1, 1.5, NaN]) assert.throws(() => attendeeKey(index));
});

test("maximum snapshot fallback fits the $180 infrastructure approval and $100 model estimate", () => {
  const budget = workshopBudget(20, 1440);
  assert.ok(budget.infrastructureUsd < 180);
  assert.ok(budget.infrastructureUsd > 179);
  assert.equal(budget.diskReserveUsd, 12);
  assert.equal(budget.infrastructureUsd, budget.computeUsd + budget.diskReserveUsd);
  assert.equal(budget.modelAllowancePerMemberUsd, 5);
  assert.equal(budget.totalEstimatedModelAllowanceUsd, 100);
  assert.ok(workshopBudget(1, 60).infrastructureUsd < 1);
});

test("failure of the pilot prevents ALL nineteen subsequent provisions", async () => {
  const calls: number[] = [];
  await assert.rejects(bootAttendees(20, async (index) => { calls.push(index); throw new Error("real model failed"); }), /real model failed/);
  assert.deepEqual(calls, [1]);
});

test("fan-out is bounded to two and starts only after pilot proof; results remain seat ordered", async () => {
  let pilotDone = false; let concurrent = 0; let maximum = 0;
  const values = await bootAttendees(20, async (index) => {
    if (index !== 1) assert.ok(pilotDone);
    concurrent++; maximum = Math.max(maximum, concurrent);
    await new Promise((resolve) => setImmediate(resolve));
    concurrent--;
    if (index === 1) pilotDone = true;
    return attendeeKey(index);
  });
  assert.equal(maximum, 2);
  assert.deepEqual(values, Array.from({ length: 20 }, (_, i) => attendeeKey(i + 1)));
});

test("a failed worker settles its in-flight sibling before the caller tears down ownership", async () => {
  let siblingSettled = false;
  await assert.rejects(bootAttendees(20, async (index) => {
    if (index === 1) return index;
    if (index === 2) { await new Promise((resolve) => setImmediate(resolve)); throw new Error("OAuth failed"); }
    if (index === 3) { await new Promise((resolve) => setTimeout(resolve, 20)); siblingSettled = true; return index; }
    assert.fail("must stop queue after failure");
  }), /OAuth failed/);
  assert.ok(siblingSettled);
});

test("single VM pilot does not fan out", async () => {
  const calls: number[] = [];
  assert.deepEqual(await bootAttendees(1, async (index) => { calls.push(index); return index; }), [1]);
  assert.deepEqual(calls, [1]);
});

const info = { public: false, organizationId: "802dbb61-97d4-445a-9c80-e9255852a4e0", sandboxClass: "container", target: "us", id: "12345678-1234-1234-1234-123456789abc", cpu: 2, memory: 4, disk: 10 };
test("handover fails closed for private org, actual hardware and Linux target", () => {
  assert.equal(validateSandboxInfo(info).memoryGiB, 4);
  assert.equal(validateSandboxInfo({ ...info, cpu: 4, memory: 8 }).cpu, 4);
  for (const override of [{ public: true }, { public: undefined }, { cpu: 8 }, { memory: 16 }, { cpu: 0 }, { memory: -1 }, { disk: 20 }, { disk: undefined }, { organizationId: "other-org" }, { sandboxClass: "windows" }, { target: "eu" }, { id: "unverified-name" }]) {
    assert.throws(() => validateSandboxInfo({ ...info, ...override }));
  }
});

test("pilot requires a completed read and a final fact grounded in its real output, never just a marker", () => {
  const part = { type: "tool", tool: "mcp:connection1:search_issues", callId: "call1", status: "completed", input: {}, text: "", error: "", output: JSON.stringify({ issues: [{ summary: "Northwind rollout readiness", id: "NW-1" }] }) };
  const final = 'Northwind: "Northwind rollout readiness" (NW-1). WORKSHOP_READY';
  assert.equal(validatePilotRead([part], final, ["connection1"]).title, "Northwind rollout readiness");
  for (const overrides of [{ status: "running" }, { status: "error" }, { error: "upstream failed" }, { tool: "shell" }, { tool: "mcp:connection1:delete_issue" }, { output: '{"isError":true,"summary":"Northwind rollout readiness"}' }, { output: '{"issues":[]}' }]) {
    assert.throws(() => validatePilotRead([{ ...part, ...overrides }], final, ["connection1"]));
  }
  assert.throws(() => validatePilotRead([], "Tools failed WORKSHOP_READY", ["connection1"]));
  assert.throws(() => validatePilotRead([part], "Northwind tools failed WORKSHOP_READY", ["connection1"]));
  assert.throws(() => validatePilotRead([part], "Northwind made-up item title WORKSHOP_READY", ["connection1"]));
});

test("OS HTTP and HTTPS use the exact existing caller-owned Chrome profile", () => {
  const script = workshopBrowserInstaller();
  assert.ok(script.includes(`--user-data-dir=${WORKSHOP_BROWSER_PROFILE}`));
  assert.ok(script.includes(`chmod 700 ${WORKSHOP_BROWSER_LAUNCHER}`));
  assert.ok(script.includes("export DISPLAY=:99"));
  assert.ok(script.includes("xdg-settings set default-web-browser"));
  assert.ok(script.includes("xdg-mime default openwork-workshop-browser.desktop x-scheme-handler/http"));
  assert.ok(script.includes("xdg-mime default openwork-workshop-browser.desktop x-scheme-handler/https"));
  assert.ok(!/headless|OPENAI|api_key|token|password/.test(script));
});
