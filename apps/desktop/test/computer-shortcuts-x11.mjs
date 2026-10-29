// Real Linux desktop proof. Run with OPENWORK_TEST_COMPUTER_CONTAINER set to an
// isolated container running fixtures/computer-shortcuts-gtk.py under Xvfb and
// dbus-run-session. No production VM, credentials or personal desktop is used.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComputerControl } from "@openwork/computer-use/computer-control";
import { createRemoteComputerAdapter } from "@openwork/computer-use/computer-remote";
import { createX11Driver } from "@openwork/computer-use/computer-x11-driver";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createCloudComputer } from "@openwork/computer-use/cloud";

const container = process.env.OPENWORK_TEST_COMPUTER_CONTAINER;
assert.ok(container, "Set OPENWORK_TEST_COMPUTER_CONTAINER to the isolated GTK fixture container.");
const exec = promisify(execFile);
let commands = 0;
let workerDirectory = "";
const machine = {
  async run(command, timeoutMs) {
    commands++;
    workerDirectory ||= command.match(/\/tmp\/openwork-computer-[a-f0-9-]+/)?.[0] ?? "";
    try {
      const result = await exec("docker", ["exec", container, "sh", "-c", "set -a; . /tmp/computer-shortcuts-dbus; set +a; " + command], { timeout: timeoutMs + 2000, maxBuffer: 3_000_000 });
      return { exitCode: 0, ...result };
    } catch (error) { return { exitCode: 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" }; }
  },
  async read(path, timeout) { return (await exec("docker", ["exec", container, "cat", path], { timeout, encoding: "buffer", maxBuffer: 3_000_000 })).stdout; },
};
const driver = createX11Driver({ machine });
const adapter = createRemoteComputerAdapter({ id: "proof-vm", label: "Proof desktop", driver });
const control = createComputerControl({ adapters: [adapter], readRemoteFeatureEnabled: async () => true, runProgram: runComputerProgram });
const state = async () => JSON.parse((await exec("docker", ["exec", container, "cat", "/tmp/computer-shortcuts-state.json"])).stdout);
const call = (code, options = {}) => control.program({ sessionId: "proof-chat", surface: "computer", code, timeoutMs: 60000 }, options);
try {
  const disabled = await call('return await tools.ui.observe({});');
  assert.equal(disabled.ok, false);
  await control.setFeatureEnabled(true);
  await control.setRemoteEnabled(true);
  await control.choose({ sessionId: "proof-chat", targetId: "proof-vm" });
  await control.execute({ sessionId: "proof-chat", name: "computer_open", args: { app_id: "desktop", mode: "control", purpose: "Save a project and open a list item" } });
  const initialSaved = (await state()).saved.length;
  const result = await call(`
    await tools.ui.fillForm({fields:[{target:{role:"textbox",name:"Project name"},text:"Website refresh"}]});
    await tools.ui.setChecked({target:{role:"checkbox",name:"Include details"},checked:true});
    await tools.ui.setChecked({target:{role:"checkbox",name:"Include details"},checked:true});
    await tools.ui.click({target:{role:"button",name:"Save project"}});
    await tools.ui.waitFor({target:{name:"Saved: Website refresh"},timeoutMs:5000});
    const row = await tools.ui.scrollUntil({target:{role:"button",name:"Project 35"},container:{role:"region",name:"Projects"},maxPages:12});
    if (!row.found) return row;
    await tools.ui.click({target:row.target});
    await tools.ui.waitFor({target:{name:"Opened: Project 35"}});
    return {saved:true,opened:35};
  `);
  console.log("semantic program", JSON.stringify(result));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { saved: true, opened: 35 });
  const saved = await state();
  assert.equal(saved.saved.length, initialSaved + 1);
  assert.deepEqual(saved.saved.at(-1), { name: "Website refresh", details: true });

  // The physical typing path must use one worker request, not one per chunk.
  await call('await tools.ui.click({target:{role:"textbox",name:"Project name"}}); return true;');
  const before = commands;
  const typed = await driver.input([{ type: "key", key: "a", modifiers: ["control"] }, { type: "type", text: "x".repeat(1000) }]);
  assert.equal(typed.completed, 2);
  assert.equal(commands - before, 1);
  let settled = await state();
  for (let attempt = 0; attempt < 50 && settled.text !== "x".repeat(1000); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    settled = await state();
  }
  assert.equal(settled.text, "x".repeat(1000));
  console.log("long text", JSON.stringify({ completed: typed.completed, providerCommands: commands - before, characters: 1000 }));

  // Cancel while typing, then prove the remaining text never arrives.
  const controller = new AbortController();
  const typing = driver.input([{ type: "key", key: "a", modifiers: ["control"] }, { type: "type", text: "y".repeat(8000) }], { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 180));
  controller.abort();
  const interrupted = await typing;
  assert.ok(interrupted.completed < 2);
  await new Promise(resolve => setTimeout(resolve, 300));
  const partial = (await state()).text;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await state()).text, partial);
  assert.ok(partial.length < 8000);
  console.log("cancellation", JSON.stringify({ completed: interrupted.completed, stoppedAtCharacters: partial.length }));

  const waiting = call('await tools.ui.waitFor({target:{name:"Never appears"},timeoutMs:15000}); return true;');
  await new Promise(resolve => setTimeout(resolve, 100));
  await control.setFeatureEnabled(false);
  assert.equal((await waiting).ok, false);
  console.log("flag rollback", JSON.stringify({ blocked: true }));

  // A killed worker leaves its socket behind. Read-only recovery must restart
  // it without replaying any preceding input or changing the fixture state.
  assert.match(workerDirectory, /^\/tmp\/openwork-computer-[a-f0-9-]+$/);
  await exec("docker", ["exec", container, "pkill", "-f", `^python3 ${workerDirectory}/worker.py `]);
  const recovered = await driver.accessibility({ x: 0, y: 0, width: 1280, height: 900 }, { observationId: "recovered" });
  assert.equal(recovered.capability, "atspi");
  assert.ok(recovered.elements.some(element => element.name === "Project name"));
  assert.equal((await state()).text, partial);
  console.log("worker recovery", JSON.stringify({ staleSocketRestarted: true, inputReplayed: false }));

  const directory = await mkdtemp(join(tmpdir(), "computer-shortcuts-cloud-"));
  const cloud = await createCloudComputer({ directory, machine, enabled: async () => true });
  try {
    const result = await cloud.task("/computer/program", { sessionId: "cloud-proof", surface: "computer", timeoutMs: 60000, code: `
      await tools.ui.open({appId:"desktop"});
      await tools.ui.fill({target:{role:"textbox",name:"Project name"},text:"Cloud program"});
      return {filled:true};
    ` });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await state()).text, "Cloud program");
    const waiting = cloud.task("/computer/program", { sessionId: "cloud-proof", surface: "computer", code: 'await tools.ui.waitFor({target:{name:"Never appears"},timeoutMs:15000}); return true;' });
    await new Promise(resolve => setTimeout(resolve, 150));
    await cloud.interact({ action: "takeover" });
    assert.equal((await waiting).ok, false);
    console.log("cloud program", JSON.stringify({ filled: true, takeoverStopped: true }));
  } finally { await cloud.close(); await rm(directory, { recursive: true, force: true }); }

  // Two top-level windows share one PID and overlap. Selecting one must never
  // expose or activate a sibling control, even with a previous desktop ref.
  await exec("docker", ["exec", container, "pkill", "-USR1", "-f", "^python3 /tmp/computer-shortcuts-gtk.py$"]);
  await new Promise(resolve => setTimeout(resolve, 400));
  const windows = await driver.windows();
  const primary = windows.find(window => window.title === "Computer shortcuts proof");
  assert.ok(primary);
  const whole = await driver.accessibility(await driver.screen(), { observationId: "whole-sibling" });
  const sibling = whole.elements.find(element => element.name === "Sibling only");
  assert.ok(sibling);
  const refused = await driver.input([{ type: "press", ref: sibling.ref }], { observationId: "whole-sibling", windowId: primary.id });
  assert.equal(refused.completed, 0);
  assert.match(refused.error, /window scope/);
  const scoped = await driver.accessibility(primary.region, { observationId: "selected-window", windowId: primary.id });
  assert.ok(scoped.elements.some(element => element.name === "Project name"), JSON.stringify(scoped));
  assert.equal(scoped.elements.some(element => element.name === "Sibling only"), false);
  const field = scoped.elements.find(element => element.name === "Project name");
  const edited = await driver.input([{ type:"set_value", ref:field.ref, text:"Selected window" }], { observationId:"selected-window", windowId:primary.id });
  assert.equal(edited.completed,1,JSON.stringify(edited));
  assert.equal((await state()).text,"Selected window");
  assert.equal((await state()).siblingClicks ?? 0, 0);
  console.log("window scope", JSON.stringify({ primaryControlsAvailable: true, siblingHidden: true, siblingInputRefused: true }));
} finally { await control.reset(true); }
