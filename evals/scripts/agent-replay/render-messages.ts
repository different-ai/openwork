import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Renders replayed messages as the member sees them in Slack (a DM from the OpenWork app), today's prompts next to
 * the brief's pipeline for the same recorded day, and screenshots each scenario with headless Chrome.
 *
 *   node --conditions=development evals/scripts/agent-replay/render-messages.ts <runs.json> <out dir> [scenario …]
 */

const runSchema = z.array(z.object({
  run: z.object({ scenario: z.string(), pipeline: z.enum(["old", "new"]), messages: z.array(z.object({ at: z.number(), text: z.string() })) }),
}));

const CHROME = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TZ = "America/New_York";

function escape(text: string) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Slack mrkdwn as Slack shows it: `<url|label>` links, *bold*, line breaks. */
function mrkdwn(text: string) {
  return escape(text)
    .replace(/&lt;(https?:\/\/[^|\s]+?)\|(.+?)&gt;/g, '<a href="$1">$2</a>')
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,])/g, "$1<b>$2</b>")
    .replaceAll("\n", "<br>");
}

/** Characters a reader sees: links as their labels. */
function visibleLength(text: string) {
  return text.replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "$2").length;
}

function clock(at: number) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "2-digit" }).format(at);
}

function column(title: string, messages: { at: number; text: string }[]) {
  const body = messages.length
    ? messages.map((message) => `<div class="msg"><img src="data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><rect width="36" height="36" rx="8" fill="#011627"/><circle cx="18" cy="18" r="8" fill="none" stroke="#fff" stroke-width="3"/></svg>')}"><div><div class="who"><b>OpenWork</b><span class="app">APP</span><span class="time">${clock(message.at)}</span></div><div class="text">${mrkdwn(message.text)}</div></div></div>`).join("")
    : '<div class="none">No messages</div>';
  return `<section><h2>${title} <span>${messages.length} message${messages.length === 1 ? "" : "s"}</span></h2>${body}</section>`;
}

const [runsPath, outDir, ...only] = process.argv.slice(2);
if (!runsPath || !outDir) throw new Error("usage: render-messages.ts <runs.json> <out dir> [scenario …]");
const runs = runSchema.parse(JSON.parse(readFileSync(runsPath, "utf8")));
mkdirSync(outDir, { recursive: true });
const scenarios = [...new Set(runs.map((entry) => entry.run.scenario))].filter((id) => !only.length || only.includes(id));
for (const scenario of scenarios) {
  const first = (pipeline: "old" | "new") => runs.find((entry) => entry.run.scenario === scenario && entry.run.pipeline === pipeline)?.run.messages ?? [];
  const old = first("old");
  const neu = first("new");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#fff;font:15px/1.46 -apple-system,BlinkMacSystemFont,"Segoe UI",Lato,sans-serif;color:#1d1c1d}
    header{padding:18px 24px 6px;font-weight:700;font-size:17px}header span{font-weight:400;color:#616061;font-size:14px;margin-left:8px}
    main{display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid #e8e8e8}
    section{padding:12px 20px 20px;border-right:1px solid #e8e8e8}section:last-child{border-right:0}
    h2{font-size:13px;text-transform:none;color:#616061;font-weight:600;margin:4px 0 10px}h2 span{font-weight:400;margin-left:6px}
    .msg{display:flex;gap:10px;padding:8px 0}.msg img{width:36px;height:36px;border-radius:8px;flex:none}
    .who{font-size:15px}.app{font-size:10px;background:#e8e8e8;color:#616061;border-radius:3px;padding:1px 4px;margin:0 6px;font-weight:700}.time{color:#616061;font-size:12px}
    .text{white-space:normal;word-wrap:break-word}a{color:#1264a3;text-decoration:none}.none{color:#616061;font-style:italic;padding:8px 0}
  </style><header>Workbot DM <span>${escape(scenario)}, first run of each</span></header><main>${column("Old prompts", old)}${column("New pipeline", neu)}</main>`;
  const file = join(outDir, `${scenario}.html`);
  writeFileSync(file, html);
  const longest = Math.max(...[old, neu].map((list) => list.reduce((sum, message) => sum + 50 + Math.ceil(visibleLength(message.text) / 78) * 22, 0)), 60);
  const height = 110 + longest;
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=1280,${height}`, `--screenshot=${join(outDir, `${scenario}.png`)}`, `file://${file}`], { stdio: "ignore" });
  console.log(`${scenario}: ${old.length} old, ${neu.length} new → ${join(outDir, `${scenario}.png`)}`);
}
