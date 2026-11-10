import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { dispatchDesktopEntry, runLoginCommand } from "../electron/login-command.mjs";

function fixture(platform = "linux") {
  const calls = [];
  const signals = new EventEmitter();
  const child = new EventEmitter();
  child.kill = (signal) => { calls.push(["kill", signal]); return true; };
  const app = {
    commandLine: { appendSwitch: (...args) => calls.push(["switch", ...args]) },
    disableHardwareAcceleration: () => calls.push(["disableHardwareAcceleration"]),
    setActivationPolicy: (...args) => calls.push(["activation", ...args]),
    setPath: (...args) => calls.push(["path", ...args]),
    setAppLogsPath: (...args) => calls.push(["logs", ...args]),
    exit: (code) => calls.push(["exit", code]),
  };
  const env = {
    HOME: "/real/home",
    OPENWORK_UI_CONTROL_DISCOVERY: "/real/profile/openwork-ui-control.json",
    OPENWORK_ELECTRON_USERDATA: "/real/profile",
  };
  const options = {
    app, platform, signals, env,
    execPath: "/installed/OpenWork",
    args: [],
    createProfile: () => { calls.push(["createProfile"]); return "/temporary/login"; },
    removeProfile: (directory) => calls.push(["removeProfile", directory]),
    spawnChild: (...args) => { calls.push(["spawn", ...args]); return child; },
    writeError: (message) => calls.push(["error", message]),
  };
  return { app, options, calls, signals, child, env };
}

for (const argv of [
  ["/installed/OpenWork"],
  ["/installed/OpenWork", "--version"],
  ["/installed/OpenWork", "openwork://connect", "login"],
  ["/installed/OpenWork", "device-login"],
]) {
  test(`non-command dispatch preserves GUI startup: ${argv.slice(1).join(" ") || "no args"}`, async () => {
    let gui = 0;
    const { app, calls } = fixture();
    await dispatchDesktopEntry({ app, argv, loadGui: () => { gui++; } });
    assert.equal(gui, 1);
    assert.deepEqual(calls, []);
  });
}

for (const defaultApp of [false, true]) {
  test(`login bypasses every GUI import (${defaultApp ? "development" : "packaged"})`, () => {
    const { options, calls, child } = fixture();
    const argv = defaultApp
      ? ["/electron", "/source/electron/entry.mjs", "login", "--force"]
      : ["/installed/OpenWork", "login", "--force"];
    dispatchDesktopEntry({ ...options, argv, defaultApp, loadGui: () => assert.fail("GUI imported") });
    assert.deepEqual(calls.find(([name]) => name === "spawn")[2].slice(1), ["login", "--force"]);
    child.emit("close", 0, null);
  });
}

test("delegates the actual bundled CLI in Node mode, preserving HOME and explicit discovery", () => {
  const { options, calls, child, env } = fixture();
  const args = ["--force", "--base-url", "https://den.example.test", "--api-base-url", "https://api.example.test"];
  runLoginCommand({ ...options, args });
  const [, executable, childArgs, childOptions] = calls.find(([name]) => name === "spawn");
  assert.equal(executable, options.execPath);
  assert.deepEqual(childArgs, [
    fileURLToPath(new URL("../server/dist/cli.js", import.meta.url)), "login", ...args,
  ]);
  assert.deepEqual(childOptions, {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit", detached: true, windowsHide: true,
  });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  child.emit("close", 0, null);
});

for (const platform of ["linux", "darwin", "win32"]) {
  test(`${platform} prepares only an isolated parent, before child spawn`, () => {
    const { options, calls, child, signals } = fixture(platform);
    runLoginCommand(options);
    assert.equal(signals.listenerCount("SIGHUP"), platform === "win32" ? 0 : 1);
    const beforeSpawn = calls.slice(0, calls.findIndex(([name]) => name === "spawn"));
    assert.deepEqual(beforeSpawn.filter(([name]) => name === "path"), [
      ["path", "userData", "/temporary/login"],
      ["path", "sessionData", "/temporary/login"],
      ["path", "crashDumps", "/temporary/login"],
    ]);
    assert.deepEqual(beforeSpawn.filter(([name]) => name === "logs"), [["logs", "/temporary/login"]]);
    assert.deepEqual(beforeSpawn.filter(([name]) => name === "switch"), platform === "linux"
      ? [["switch", "ozone-platform", "headless"]] : []);
    assert.equal(beforeSpawn.some(([name]) => name === "disableHardwareAcceleration"), platform === "linux");
    assert.deepEqual(beforeSpawn.filter(([name]) => name === "activation"), platform === "darwin"
      ? [["activation", "prohibited"]] : []);
    assert.equal(calls.find(([name]) => name === "spawn")[3].detached, platform !== "win32");
    child.emit("close", platform === "win32" ? 4 : 0, null);
    assert.deepEqual(calls.at(-2), ["removeProfile", "/temporary/login"]);
    assert.deepEqual(calls.at(-1), ["exit", platform === "win32" ? 4 : 0]);
  });
}

test("Linux sandbox override requires the existing exact explicit flag", () => {
  for (const value of [undefined, "0", "true", "1"]) {
    const { options, calls, child } = fixture();
    runLoginCommand({ ...options, env: {
      ...options.env,
      ELECTRON_DISABLE_SANDBOX: value,
      ELECTRON_EXTRA_LAUNCH_ARGS: "--no-sandbox --remote-debugging-port=9999",
    } });
    assert.deepEqual(calls.filter(([name]) => name === "switch"), [
      ["switch", "ozone-platform", "headless"],
      ...(value === "1" ? [["switch", "no-sandbox"]] : []),
    ]);
    child.emit("close", 0, null);
  }
});

for (const code of [0, 1, 2, 3, 4, 130]) {
  test(`preserves CLI exit ${code} and removes listeners/profile once`, () => {
    const { options, calls, signals, child } = fixture();
    runLoginCommand(options);
    child.emit("close", code, null);
    child.emit("close", 1, null);
    assert.deepEqual(calls.filter(([name]) => name === "exit"), [["exit", code]]);
    assert.deepEqual(calls.filter(([name]) => name === "removeProfile"), [["removeProfile", "/temporary/login"]]);
    assert.equal(signals.listenerCount("SIGINT"), 0);
    assert.equal(signals.listenerCount("SIGTERM"), 0);
    assert.equal(signals.listenerCount("SIGHUP"), 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`${signal} forwards once and waits for CLI cancellation cleanup`, () => {
    const { options, calls, signals, child } = fixture();
    runLoginCommand(options);
    signals.emit(signal);
    signals.emit(signal);
    signals.emit(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
    signals.emit("SIGHUP");
    assert.deepEqual(calls.filter(([name]) => name === "kill"), [
      ["kill", signal === "SIGHUP" ? "SIGTERM" : signal],
    ]);
    assert.equal(calls.some(([name]) => name === "exit" || name === "removeProfile"), false);
    child.emit("close", 130, null);
    assert.deepEqual(calls.at(-1), ["exit", 130]);
    assert.equal(signals.listenerCount("SIGHUP"), 0);
  });
}

for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143], [null, 1]]) {
  test(`maps child termination ${signal} to ${expected}`, () => {
    const { options, calls, child } = fixture();
    runLoginCommand(options);
    child.emit("close", null, signal);
    assert.deepEqual(calls.at(-1), ["exit", expected]);
  });
}

test("spawn errors fail safely without printing error details or exiting twice", () => {
  const { options, calls, child } = fixture();
  runLoginCommand(options);
  child.emit("error", new Error("sensitive diagnostic"));
  child.emit("close", -2, null);
  assert.deepEqual(calls.filter(([name]) => name === "exit"), [["exit", 1]]);
  assert.deepEqual(calls.filter(([name]) => name === "error"), [
    ["error", "Device sign-in could not start. Use the sign-in link instead."],
  ]);
});

test("synchronous startup failures remove only the temporary parent profile", () => {
  const { options, calls, signals } = fixture();
  runLoginCommand({ ...options, spawnChild: () => { throw new Error("private path"); } });
  assert.deepEqual(calls.at(-2), ["removeProfile", "/temporary/login"]);
  assert.deepEqual(calls.at(-1), ["exit", 1]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("packaging and development start through the small entry, not GUI main", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.main, "electron/entry.mjs");
  assert.match(pkg.scripts.electron, /electron \.\/electron\/entry\.mjs/);
  const entry = readFileSync(new URL("../electron/entry.mjs", import.meta.url), "utf8");
  assert.match(entry, /loadGui: \(\) => import\("\.\/main\.mjs"\)/);
  assert.doesNotMatch(entry, /from ["']\.\/main\.mjs/);
  const development = readFileSync(new URL("../scripts/electron-dev.mjs", import.meta.url), "utf8");
  assert.match(development, /"electron", "\.\/electron\/entry\.mjs"/);
});
