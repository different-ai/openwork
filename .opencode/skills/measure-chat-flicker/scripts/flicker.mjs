#!/usr/bin/env node
// Measure layout jumps while a turn runs: samples the "Working" line's
// position every 50ms and counts upward moves (content shrinking under it).
//   CDP_URL=http://127.0.0.1:<cdp> node flicker.mjs arm
//   … fire a turn (e.g. reproduce-chat-states sequential-commands) …
//   CDP_URL=… node flicker.mjs report
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cdp = join(dirname(fileURLToPath(import.meta.url)), "../../drive-desktop-cdp/scripts/cdp.mjs");
const evaluate = (js) => execFileSync("node", [cdp, "eval", js]).toString().trim();

const arm = `(() => {
  clearInterval(window.__flicker?.timer);
  const state = { log: [], last: null, start: 0 };
  state.timer = setInterval(() => {
    const line = document.querySelector("[data-loading-message]");
    const top = line ? Math.round(line.getBoundingClientRect().top) : null;
    if (String(top) === state.last) return;
    if (!state.start) state.start = performance.now();
    state.log.push([Math.round(performance.now() - state.start), top]);
    state.last = String(top);
  }, 50);
  window.__flicker = state;
  return "armed";
})()`;

const report = `(() => {
  const state = window.__flicker;
  if (!state) return "not armed";
  clearInterval(state.timer);
  let up = 0, down = 0;
  for (let i = 1; i < state.log.length; i++) {
    const [, a] = state.log[i - 1], [, b] = state.log[i];
    if (a !== null && b !== null && a !== b) b < a ? up++ : down++;
  }
  return { upwardJumps: up, downwardMoves: down, samples: state.log.map((s) => s.join(",")).join(" ") };
})()`;

const command = process.argv[2];
if (command !== "arm" && command !== "report") {
  console.error("usage: flicker.mjs arm|report");
  process.exit(1);
}
console.log(evaluate(command === "arm" ? arm : report));
