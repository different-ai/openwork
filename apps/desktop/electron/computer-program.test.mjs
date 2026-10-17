import assert from "node:assert/strict";
import test from "node:test";
import { runComputerProgram } from "@openwork/computer-use/runtime";
import { createComputerControl, COMPUTER_PROTOCOL } from "@openwork/computer-use/computer-control";

function browserFixture() {
  let value = "";
  let checked = false;
  let saves = 0;
  let observationId = 0;
  const calls = [];
  const host = {
    computer: async () => { throw new Error("Wrong surface"); },
    browser: async (operation, args, _signal) => {
      calls.push(operation);
      if (operation === "open") return { ok: true, tabId: "owned" };
      if (operation === "observe") return { ok: true, observationId: String(++observationId), viewport: { width: 800, height: 600 }, text: saves ? "Saved 1" : "Ready", elements: [
        { ref: "title", role: "textbox", name: "Title", value, bounds: { x: 10, y: 10, width: 300, height: 30 } },
        { ref: "details", role: "checkbox", name: "Details", checked, bounds: { x: 10, y: 50, width: 100, height: 30 } },
        { ref: "save", role: "button", name: "Save", bounds: { x: 10, y: 90, width: 100, height: 30 } },
        ...(saves ? [{ ref: "saved", role: "text", name: "Saved 1", bounds: { x: 10, y: 130, width: 100, height: 30 } }] : []),
      ], ...(args.includeImage ? { image: { mimeType: "image/png", data: "fixture-pixels" } } : {}) };
      if (operation === "act") {
        assert.equal(args.observationId, String(observationId));
        observationId++;
        const action = args.action;
        if (action.type === "fill") value = action.text;
        if (action.type === "click" && action.ref === "details") checked = !checked;
        if (action.type === "set_checked" && action.ref === "details") checked = action.checked;
        if (action.type === "click" && action.ref === "save") saves++;
        return { ok: true, dispatched: true };
      }
      throw new Error("Unknown fixture operation");
    },
  };
  return { host, calls, state: () => ({ value, checked, saves }) };
}

test("a conditional program fills, checks idempotently and saves once", async () => {
  const f = browserFixture();
  const result = await runComputerProgram({ surface: "browser", code: `
    await tools.ui.fill({target:{role:"textbox",name:"Title"},text:"Weekly report"});
    await tools.ui.setChecked({target:{name:"Details"},checked:true});
    await tools.ui.setChecked({target:{name:"Details"},checked:true});
    if(await tools.ui.exists({target:{name:"Save"}})) await tools.ui.click({target:{name:"Save"}});
    await tools.ui.waitFor({target:{text:"Saved 1"}});
    return {saved:true};
  ` }, f.host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { saved: true });
  assert.deepEqual(f.state(), { value: "Weekly report", checked: true, saves: 1 });
  assert.equal(result.metrics.actions, 3);
});

test("images are attached outside program JSON and failed input is never replayed", async () => {
  let inputs = 0;
  const f = browserFixture();
  const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.observe({screenshot:true}); await tools.ui.click({target:{name:"Save"}}); return true;' }, {
    ...f.host,
    browser: async (operation, args, signal) => {
      if (operation === "act") { inputs++; return { ok: false, code: "disconnected", error: "Receipt unavailable", mayHaveChangedState: true }; }
      return f.host.browser(operation, args, signal);
    },
  }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "disconnected");
  assert.equal(inputs, 1);
  assert.deepEqual(result.images, []);
  assert.equal(result.mayHaveActed, true);
  assert.deepEqual(result.receipts, [{ index: 0, status: "unconfirmed" }]);
});

test("native partial receipts survive a failed program without replay", async () => {
  let inputs = 0;
  const text = value => ({content:[{type:"text",text:JSON.stringify(value)}]});
  const result = await runComputerProgram({surface:"computer",code:'await tools.ui.act({action:{type:"key",key:"enter"}}); return true;'}, {
    browser: async () => { throw new Error("Wrong surface"); },
    computer: async name => {
      if(name === "computer_observe") return text({ok:true,observation_id:"fresh",width:800,height:600,elements:[]});
      inputs++;
      return text({ok:true,status:"partial",completed:0,failed:0,skipped:0,may_have_acted:true,message:"Input interrupted"});
    },
  }, new AbortController().signal);
  assert.equal(result.ok,false);
  assert.equal(inputs,1);
  assert.deepEqual(result.receipts,[{index:0,status:"partial",completed:0,failed:0,skipped:0}]);
});

test("code has no ambient filesystem, process or network access", async () => {
  for (const code of ['return process.env;', 'return require("node:fs");', 'return await fetch("https://example.com");']) {
    const f = browserFixture();
    const result = await runComputerProgram({ surface: "browser", code }, f.host, new AbortController().signal);
    assert.equal(result.ok, false);
    assert.deepEqual(f.calls, []);
  }
});

test("an offscreen control is hidden to waits and revealed before clicking", async () => {
  const f = browserFixture();
  const dispatched = [];
  let revealed = false;
  const host = { ...f.host, browser: async (operation, args, signal) => {
    const result = await f.host.browser(operation, args, signal);
    if (operation === "observe" && "elements" in result) result.elements = result.elements.map(element => ({ ...element, visible: element.ref !== "save" || revealed }));
    if (operation === "act") { dispatched.push(args.action.type); if (args.action.type === "reveal") revealed = true; }
    return result;
  } };
  const result = await runComputerProgram({ surface: "browser", code: `
    await tools.ui.waitFor({target:{name:"Save"},state:"hidden"});
    await tools.ui.click({target:{name:"Save"}});
    await tools.ui.waitFor({target:{name:"Save"},state:"visible"});
    return true;
  ` }, host, new AbortController().signal);
  assert.equal(result.ok, true);
  assert.deepEqual(dispatched, ["reveal", "click"]);
  assert.equal(f.state().saves, 1);
});

test("a failed navigation receipt is marked uncertain and is never repeated", async () => {
  const f = browserFixture();
  let opens = 0;
  const result = await runComputerProgram({ surface: "browser", code: 'await tools.ui.open({url:"https://example.com"}); return true;' }, {
    ...f.host, browser: async () => { opens++; throw new Error("Navigation receipt lost"); },
  }, new AbortController().signal);
  assert.equal(result.ok, false);
  assert.equal(result.mayHaveActed, true);
  assert.equal(opens, 1);
});

test("the broker gates programs and cancels old waits across off/on", async (t) => {
  const f = browserFixture();
  const control = createComputerControl({
    adapters: [{ id: "local", label: "Local", placement: "local", protocol: COMPUTER_PROTOCOL, readiness: async () => ({ readiness: "ready", detail: "Ready" }), connect: async () => { throw new Error("Browser programs never open a native helper"); } }],
    runProgram: runComputerProgram,
    browserTask: ({ operation, args }, { signal }) => f.host.browser(operation, args, signal),
  });
  t.after(() => control.reset(true));
  /** @type {import("@openwork/computer-use/runtime").ProgramRequest & { sessionId: string }} */
  const input = { sessionId: "chat", surface: "browser", code: 'return await tools.ui.waitFor({target:{name:"Not here"},timeoutMs:5000});' };
  assert.equal((await control.program(input)).ok, false);
  assert.deepEqual(f.calls, []);
  await control.setFeatureEnabled(true);
  const running = control.program(input);
  while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await control.program(input)).error.code, "program_busy");
  await control.setFeatureEnabled(false);
  await control.setFeatureEnabled(true);
  const stopped = await running;
  assert.equal(stopped.ok, false);
  const count = f.calls.length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(f.calls.length, count);
});
