// The runner behind `fill_from`: what counts as a command a card can show, and what comes back from one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runValueCommand, showValueCommand, validUnlockValue, validValueAsk, validValueCommand, validValueUnlock } from "./value-command.mjs";

const NODE = process.execPath;
/** A command that runs `script` in this Node. */
const node = (script, ...args) => [NODE, "-e", script, ...args];
// Made up for the test.
const VALUE = "made-up value/+ &42";

test("a command is a program, bare or absolute, and arguments a card can show whole", () => {
  for (const command of [["bw", "get", "password", "example.com"], ["/opt/homebrew/bin/op", "read", "op://Private/Example/password"], ["security", "find-generic-password", "-s", "Example", "-w"], ["pass", ""]]) {
    assert.equal(validValueCommand(command), true, command.join(" "));
  }
  for (const command of [undefined, null, "bw get password", [], [""], [" bw"], ["bw "], ["-rf"], ["./bw"], ["bin/bw"], ["..\\bw"], ["bw", 7], ["bw", "a\nb"], ["bw", "a\u0000"], ["bw", "tidy‮gnp.exe"],
    ["bw", "zero​width"], ["bw", "x".repeat(513)], Array.from({ length: 17 }, () => "a"), ["bw", ...Array.from({ length: 3 }, () => "x".repeat(400))]]) {
    assert.equal(validValueCommand(command), false, JSON.stringify(command));
  }
});

test("a name to ask under is one short line a card can show whole", () => {
  for (const ask of ["GitHub password", "Code from your email", "x", "x".repeat(80), "Mot de passe \u00e9t\u00e9", "API key (staging)"]) assert.equal(validValueAsk(ask), true, ask);
  for (const ask of [undefined, null, 7, ["GitHub password"], "", " ", " GitHub password", "GitHub password ", "x".repeat(81), "two\nlines", "tab\there", "nul\u0000",
    "tidy\u202Egnp.exe", "zero\u200Bwidth"]) {
    assert.equal(validValueAsk(ask), false, JSON.stringify(ask));
  }
});

test("an unlock is one environment variable a program reads a key from, and a name to ask for the key under", () => {
  for (const unlock of [{ env: "BW_SESSION", ask: "Bitwarden session key" }, { env: "OP_SERVICE_ACCOUNT_TOKEN", ask: "1Password token" }, { env: "_x9", ask: "x" }, { env: "A".repeat(64), ask: "x".repeat(80) }]) {
    assert.equal(validValueUnlock(unlock), true, JSON.stringify(unlock));
  }
  for (const unlock of [undefined, null, "BW_SESSION", ["BW_SESSION", "key"], {}, { env: "BW_SESSION" }, { ask: "Bitwarden session key" }, { env: "", ask: "key" }, { env: "9LIVES", ask: "key" },
    { env: "BW SESSION", ask: "key" }, { env: "BW-SESSION", ask: "key" }, { env: "BW_SESSION=x", ask: "key" }, { env: "A".repeat(65), ask: "key" }, { env: 7, ask: "key" },
    { env: "BW_SESSION", ask: "" }, { env: "BW_SESSION", ask: " key" }, { env: "BW_SESSION", ask: "two\nlines" }, { env: "BW_SESSION", ask: "x".repeat(81) },
    { env: "BW_SESSION", ask: "key", value: "given" }, { env: "BW_SESSION", ask: "key", command: ["bw", "unlock", "--raw"] },
    // A variable that decides which code runs is never one a pasted value goes into.
    ...["PATH", "path", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "RUBYOPT", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "dyld_library_path"]
      .map((env) => ({ env, ask: "key" }))]) {
    assert.equal(validValueUnlock(unlock), false, JSON.stringify(unlock));
  }
});

test("a key for a command is one line of 4 to 4096 characters", () => {
  for (const value of ["abcd", "x".repeat(4096), "made-up key/+ &42==", "ünïcödé ✓"]) assert.equal(validUnlockValue(value), true, value.slice(0, 20));
  for (const value of [undefined, null, 7, ["abcd"], "", "abc", "x".repeat(4097), "two\nlines", "carriage\rreturn", "nul\u0000here"]) assert.equal(validUnlockValue(value), false, JSON.stringify(value)?.slice(0, 20));
});

test("a command is shown as one line, with awkward arguments quoted", () => {
  assert.equal(showValueCommand(["op", "read", "op://Private/Example/password"]), "op read op://Private/Example/password");
  assert.equal(showValueCommand(["bw", "get", "password", "My Bank"]), "bw get password 'My Bank'");
  assert.equal(showValueCommand(["x", "it's", "", "a;b", "$(c)"]), "x 'it'\\''s' '' 'a;b' '$(c)'");
});

test("what the command printed comes back whole, less one final line break", async () => {
  assert.deepEqual(await runValueCommand(node(`process.stdout.write(${JSON.stringify(`${VALUE}\n`)})`)), { ok: true, value: VALUE });
  assert.deepEqual(await runValueCommand(node(`process.stdout.write(${JSON.stringify(`${VALUE}\r\n`)})`)), { ok: true, value: VALUE });
  assert.deepEqual(await runValueCommand(node(`process.stdout.write(${JSON.stringify(` ${VALUE} \n\n`)})`)), { ok: true, value: ` ${VALUE} \n` });
  assert.deepEqual(await runValueCommand(node(`process.stdout.write("ünïcödé ✓")`)), { ok: true, value: "ünïcödé ✓" });
});

test("arguments reach the program as they are: no shell reads them", async () => {
  const awkward = ["$(echo no)", "`echo no`", "a;b", "a b", "*", "~", ">out", "|", "&&"];
  const result = await runValueCommand(node("process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...awkward));
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.value), awkward);
});

test("the command gets the environment and folder it is given, and no input", async () => {
  const result = await runValueCommand(node("process.stdin.on('data', () => {}).on('end', () => process.stdout.write(process.env.MADE_UP + ':' + process.cwd()))"),
    { env: { MADE_UP: "from-env" }, cwd: "/" });
  assert.deepEqual(result, { ok: true, value: "from-env:/" });
});

test("a failed command reports its exit code and the first line of its errors, never its output", async () => {
  const result = await runValueCommand(node(`process.stdout.write(${JSON.stringify(VALUE)}); console.error("\\n\\u001b[31mVault is locked.\\u001b[0m\\nsecond line"); process.exit(3)`));
  assert.deepEqual(result, { ok: false, code: "command_failed", exitCode: 3, detail: "Vault is locked." });
  const long = await runValueCommand(node(`console.error("e".repeat(5000)); process.exit(1)`));
  assert.equal(long.detail.length, 201);
  assert.deepEqual(await runValueCommand(node("process.exit(2)")), { ok: false, code: "command_failed", exitCode: 2 });
});

test("a program that is not installed, an empty answer and an answer that is not text each have a code", async () => {
  assert.deepEqual(await runValueCommand(["openwork-made-up-program-that-does-not-exist", "read"]), { ok: false, code: "command_not_found" });
  assert.deepEqual(await runValueCommand(["/made/up/openwork/program"]), { ok: false, code: "command_not_found" });
  assert.deepEqual(await runValueCommand(node("")), { ok: false, code: "command_empty" });
  assert.deepEqual(await runValueCommand(node(`process.stdout.write("\\n")`)), { ok: false, code: "command_empty" });
  assert.deepEqual(await runValueCommand(node("process.stdout.write(Buffer.from([0xff, 0xfe, 0x41]))")), { ok: false, code: "command_output_unusable" });
  assert.deepEqual(await runValueCommand(node(`process.stdout.write("x".repeat(20000))`)), { ok: false, code: "command_output_unusable" });
  assert.deepEqual(await runValueCommand(["./relative"]), { ok: false, code: "command_failed" });
});

test("a command that does not finish is stopped, by the clock or by the person", async () => {
  const started = Date.now();
  assert.deepEqual(await runValueCommand(node("setTimeout(() => {}, 60000)"), { timeoutMs: 200 }), { ok: false, code: "command_timeout" });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  assert.deepEqual(await runValueCommand(node("setTimeout(() => {}, 60000)"), { signal: controller.signal }), { ok: false, code: "canceled" });
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await runValueCommand(node(`process.stdout.write("never")`), { signal: already.signal }), { ok: false, code: "canceled" });
  assert.ok(Date.now() - started < 10_000);
});
