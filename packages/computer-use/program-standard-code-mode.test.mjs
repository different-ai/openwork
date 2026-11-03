import assert from "node:assert/strict";
import test from "node:test";
import { runComputerProgram } from "@openwork/computer-use/runtime";

// One page with a Title field, a Details checkbox and a Save button. `delayMs`
// makes each browser operation take that long, honouring the call's signal.
function page({ delayMs = 0, fail } = {}) {
  let value = "";
  let checked = false;
  let saves = 0;
  let observationId = 0;
  const calls = [];
  const wait = (signal) => delayMs ? new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }) : Promise.resolve();
  const host = {
    computer: async () => { throw new Error("Wrong surface"); },
    browser: async (operation, args, signal) => {
      calls.push(operation);
      await wait(signal);
      if (fail?.[operation]) throw fail[operation];
      if (operation === "observe") return { ok: true, observationId: String(++observationId), viewport: { width: 800, height: 600 }, text: saves ? "Saved" : "Ready", elements: [
        { ref: "title", role: "textbox", name: "Title", value, bounds: { x: 10, y: 10, width: 300, height: 30 } },
        { ref: "details", role: "checkbox", name: "Details", checked, bounds: { x: 10, y: 50, width: 100, height: 30 } },
        { ref: "save", role: "button", name: "Save", bounds: { x: 10, y: 90, width: 100, height: 30 } },
      ] };
      if (operation === "act") {
        observationId++;
        const action = args.action;
        if (action.type === "fill") value = action.text;
        if (action.type === "set_checked") checked = action.checked;
        if (action.type === "click" && action.ref === "save") saves++;
        return { ok: true, dispatched: true };
      }
      throw new Error("Unknown fixture operation");
    },
  };
  return { host, calls, state: () => ({ value, checked, saves }) };
}

const run = (code, host, { standardCodeMode, input, signal = new AbortController().signal } = {}) =>
  runComputerProgram({ surface: "browser", code, ...(input === undefined ? {} : { input }) }, host, signal, standardCodeMode === undefined ? undefined : { standardCodeMode });

test("standard JavaScript programs drive the same helpers and report the same receipts", async () => {
  const f = page();
  const result = await run(`
    await tools.ui.fill({ target: { role: "textbox", name: "Title" }, text: input.title });
    await tools.ui.setChecked({ target: { name: "Details" }, checked: true });
    const saved = await tools.ui.click({ target: { name: "Save" } });
    return { saved, found: await tools.ui.exists({ target: { name: "Save" } }) };
  `, f.host, { standardCodeMode: true, input: { title: "Weekly report" } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  // Helpers declare no output schema; their results still reach the program.
  assert.deepEqual(result.value, { saved: { clicked: true }, found: true });
  assert.deepEqual(f.state(), { value: "Weekly report", checked: true, saves: 1 });
  assert.deepEqual(result.receipts.map((receipt) => receipt.status), ["dispatched", "dispatched", "dispatched"]);
  assert.equal(result.mayHaveActed, true);
});

test("the host's option, not the program, picks the interpreter", async () => {
  // TypeScript annotations: OpenWork's Code Mode strips them, standard JavaScript rejects them.
  const typed = 'const found: boolean = await tools.ui.exists({ target: { name: "Save" } }); return found;';
  assert.deepEqual(await run(typed, page().host).then((result) => [result.ok, result.value]), [true, true]);
  const rejected = await run(typed, page().host, { standardCodeMode: true });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.kind, "ParseError");
  // Promise chaining: only standard JavaScript has it.
  const chained = 'return await tools.ui.exists({ target: { name: "Save" } }).then((found) => ({ found }));';
  assert.deepEqual((await run(chained, page().host, { standardCodeMode: true })).value, { found: true });
  assert.equal((await run(chained, page().host, { standardCodeMode: false })).error.kind, "UnsupportedSyntax");
});

test("a helper's refusal reaches a standard program; host failures stay generic", async () => {
  const refused = await run(`try { await tools.ui.click({ target: { name: "Missing" } }) } catch (error) { return error.message }`, page().host, { standardCodeMode: true });
  assert.match(refused.value, /^target_not_found: /);
  const f = page({ fail: { open: new Error("internal detail: session token abc") } });
  const crashed = await run(`try { await tools.ui.open({ url: "https://example.com" }) } catch (error) { return error.message }`, f.host, { standardCodeMode: true });
  assert.equal(crashed.value, "Tool execution failed");
});

test("a standard program changes only its own copy of input and reaches no host globals", async () => {
  const input = { items: [1, 2, 3] };
  const result = await run("input.items.push(4); return input.items.length;", page().host, { standardCodeMode: true, input });
  assert.equal(result.value, 4);
  assert.deepEqual(input, { items: [1, 2, 3] });
  const globals = await run("return [typeof fetch, typeof process, typeof require, typeof globalThis];", page().host, { standardCodeMode: true });
  assert.deepEqual(globals.value, ["undefined", "undefined", "undefined", "undefined"]);
  const constructor = await run('return [].constructor.constructor("return 1")()', page().host, { standardCodeMode: true });
  assert.equal(constructor.ok, false);
});

test("a call the program does not await sends no input after it returns", async () => {
  for (const standardCodeMode of [false, true]) {
    const f = page({ delayMs: 30 });
    const result = await run('tools.ui.click({ target: { name: "Save" } }); return 1;', f.host, { standardCodeMode });
    const receipts = JSON.stringify(result.receipts);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // OpenWork's Code Mode waits for the click; the standard engine cancels it at
    // return, and then nothing of it may reach the page.
    assert.equal(f.state().saves, standardCodeMode ? 0 : 1, `standardCodeMode ${standardCodeMode}`);
    assert.equal(result.mayHaveActed, !standardCodeMode);
    assert.equal(JSON.stringify(result.receipts), receipts, "receipts do not change after the result");
    assert.equal(f.calls.includes("act"), !standardCodeMode);
  }
});

test("Stop ends a standard program without replaying input", async () => {
  const f = page({ delayMs: 20 });
  const controller = new AbortController();
  const running = run('await tools.ui.click({ target: { name: "Save" } }); return await tools.ui.waitFor({ target: { name: "Never" }, timeoutMs: 5000 });', f.host, { standardCodeMode: true, signal: controller.signal });
  while (!f.calls.includes("act")) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort(new Error("Stop"));
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "program_stopped");
  assert.equal(f.state().saves, 1);
  assert.equal(result.mayHaveActed, true);
});
