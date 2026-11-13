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

const run = (code, host, { input, signal = new AbortController().signal } = {}) =>
  runComputerProgram({ surface: "browser", code, ...(input === undefined ? {} : { input }) }, host, signal);

test("standard JavaScript programs drive the same helpers and report the same receipts", async () => {
  const f = page();
  const result = await run(`
    await tools.ui.fill({ target: { role: "textbox", name: "Title" }, text: input.title });
    await tools.ui.setChecked({ target: { name: "Details" }, checked: true });
    const saved = await tools.ui.click({ target: { name: "Save" } });
    return { saved, found: await tools.ui.exists({ target: { name: "Save" } }) };
  `, f.host, { input: { title: "Weekly report" } });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  // Helpers declare no output schema; their results still reach the program.
  assert.deepEqual(result.value, { saved: { clicked: true }, found: true });
  assert.deepEqual(f.state(), { value: "Weekly report", checked: true, saves: 1 });
  assert.deepEqual(result.receipts.map((receipt) => receipt.status), ["dispatched", "dispatched", "dispatched"]);
  assert.equal(result.mayHaveActed, true);
});

test("standard JavaScript is the sole interpreter", async () => {
  // TypeScript annotations: OpenWork's Code Mode strips them, standard JavaScript rejects them.
  const typed = 'const found: boolean = await tools.ui.exists({ target: { name: "Save" } }); return found;';
  const rejected = await run(typed, page().host);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.kind, "ParseError");
  // Promise chaining: only standard JavaScript has it.
  const chained = 'return await tools.ui.exists({ target: { name: "Save" } }).then((found) => ({ found }));';
  assert.deepEqual((await run(chained, page().host)).value, { found: true });
});

test("a helper's refusal reaches a standard program; host failures stay generic", async () => {
  const refused = await run(`try { await tools.ui.click({ target: { name: "Missing" } }) } catch (error) { return error.message }`, page().host);
  assert.match(refused.value, /^target_not_found: /);
  const f = page({ fail: { open: new Error("internal detail: session token abc") } });
  const crashed = await run(`try { await tools.ui.open({ url: "https://example.com" }) } catch (error) { return error.message }`, f.host);
  assert.equal(crashed.value, "Tool execution failed");
});

test("a standard program changes only its own copy of input and reaches no host globals", async () => {
  const input = { items: [1, 2, 3] };
  const result = await run("input.items.push(4); return input.items.length;", page().host, { input });
  assert.equal(result.value, 4);
  assert.deepEqual(input, { items: [1, 2, 3] });
  const globals = await run("return [typeof fetch, typeof process, typeof require, typeof globalThis];", page().host);
  assert.deepEqual(globals.value, ["undefined", "undefined", "undefined", "undefined"]);
  const constructor = await run('return [].constructor.constructor("return 1")()', page().host);
  assert.equal(constructor.ok, false);
});

test("a call the program does not await sends no input after it returns", async () => {
  const f = page({ delayMs: 30 });
  const result = await run('tools.ui.click({ target: { name: "Save" } }); return 1;', f.host);
  const receipts = JSON.stringify(result.receipts);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(f.state().saves, 0);
  assert.equal(result.mayHaveActed, false);
  assert.equal(JSON.stringify(result.receipts), receipts);
  assert.equal(f.calls.includes("act"), false);
});

test("Stop ends a standard program without replaying input", async () => {
  const f = page({ delayMs: 20 });
  const controller = new AbortController();
  const running = run('await tools.ui.click({ target: { name: "Save" } }); return await tools.ui.waitFor({ target: { name: "Never" }, timeoutMs: 5000 });', f.host, { signal: controller.signal });
  while (!f.calls.includes("act")) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 60));
  controller.abort(new Error("Stop"));
  const result = await running;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "program_stopped");
  assert.equal(f.state().saves, 1);
  assert.equal(result.mayHaveActed, true);
});
