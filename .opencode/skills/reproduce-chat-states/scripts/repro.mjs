#!/usr/bin/env node
// Fire one known chat state in a NEW session of the running desktop window.
//   CDP_URL=http://127.0.0.1:<cdp> node repro.mjs <state> [gateway model name]
// States that use Fault Lab need the fake-model-faults setup first.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const cdp = join(dirname(fileURLToPath(import.meta.url)), "../../drive-desktop-cdp/scripts/cdp.mjs");
const gateway = process.argv[3] ?? process.env.GATEWAY_MODEL ?? "Claude Opus 5.5";
const ask = "Summarize the Q3 planning doc and list open decisions.";

const states = {
  "provider-refused": ["refused", ask],
  "provider-dns": ["enotfound", ask],
  "provider-reset": ["reset", ask],
  "provider-retrying": ["reset", ask],
  "provider-midstream": ["mid-stream-reset", ask],
  "provider-stall": ["stall", ask],
  "http-429": ["http-429", ask],
  "http-500": ["http-500", ask],
  "http-503": ["http-503", ask],
  "http-401": ["http-401", ask],
  "http-402": ["http-402", ask],
  "codemode-wrong-tool": [gateway, 'Call the execute tool once with exactly this code: return await tools.search({query:"slack"}) and then continue normally to find the Slack tools.'],
  "den-script-rejected": [gateway, 'Read-only. In one execute call, run openwork-cloud execute_capability_script (mode adhoc) with a script that uses tools.slack.slack_search_channels({query:"general",limit:5}).then(r => r). Keep the .then exactly. If it is rejected, fix it and retry. Do not post anything.'],
  "den-script-service-failure": [gateway, 'Read-only. In one execute call, run openwork-cloud execute_capability_script (mode adhoc) with a script that calls tools.slack.slack_search_channels({query:"", limit:20}) using await. Report the raw error. Do not retry and do not post anything.'],
  "den-script-parallel": [gateway, 'Read-only. Find slack_search_channels and slack_read_channel with openwork-cloud search_capabilities, then run ONE openwork-cloud execute_capability_script (mode adhoc, await with try/catch, no .then) that finds 10 channels and reads the latest 3 messages from each in parallel. Do not post anything. Summarize in a short table.'],
  "parallel-searches": [gateway, "Do 10 web searches in parallel about bananas, then search Slack for mentions of bananas."],
  "app-create": [gateway, "Create an MCP app that shows my next meeting on Google Calendar."],
  "sequential-commands": [gateway, "Run these 5 shell commands one at a time, as 5 separate bash tool calls, and say one short sentence between each: sleep 2 && echo one ; sleep 2 && echo two ; sleep 2 && echo three ; sleep 2 && echo four ; sleep 2 && echo five. Then say done."],
};

const state = process.argv[2];
if (!states[state]) {
  console.error(`states:\n  ${Object.keys(states).join("\n  ")}`);
  process.exit(1);
}
const [model, prompt] = states[state];
const run = (...args) => execFileSync("node", [cdp, ...args], { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
console.log(run("new-session"));
console.log(run("send", model, prompt));
console.log(`fired ${state} with "${model}". Next: node ${cdp} wait-idle && node ${cdp} shot /tmp/${state}.png`);
