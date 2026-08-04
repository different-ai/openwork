import type { PhotoRollRecord, RollFrame } from "./schema.ts";
import type { RollEntry } from "./scan.ts";

export interface RenderPrOptions {
  title?: string;
  reproCommand?: string;
  notice?: string;
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rollBadge(entry: RollEntry): { label: string; className: string; summary: string } {
  if (entry.kind === "legacy") {
    return {
      label: "LEGACY",
      className: "legacy",
      summary: `${entry.pngFiles.length} loose screenshot${entry.pngFiles.length === 1 ? "" : "s"}`,
    };
  }
  const summary = entry.roll.summary;
  if (summary.failedFrames > 0 || summary.failedExpectations > 0) {
    return {
      label: "FAILED",
      className: "failed",
      summary: `${summary.passedFrames}/${summary.totalFrames} frames passed · ${summary.failedFrames} failed`,
    };
  }
  if (summary.ok) {
    return {
      label: "PASSED",
      className: "passed",
      summary: `${summary.passedFrames}/${summary.totalFrames} frames passed`,
    };
  }
  return {
    label: "UNVALIDATED",
    className: "unvalidated",
    summary: `${summary.unvalidatedFrames}/${summary.totalFrames} frames unvalidated`,
  };
}

export function renderCollectionHtml(entries: RollEntry[]): string {
  const ordered = [...entries].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const cards = ordered.map((entry) => {
    const badge = rollBadge(entry);
    const caption = entry.kind === "roll" ? entry.roll.frames[0]?.caption : undefined;
    const thumbnail = entry.thumbnailHref
      ? `<img src="${html(entry.thumbnailHref)}" alt="${html(caption ?? entry.name)}">`
      : `<div class="empty">No screenshot recorded</div>`;
    return `<article class="card ${badge.className}">
      <a class="thumb" href="${html(entry.href)}">${thumbnail}</a>
      <div class="copy">
        <div class="topline"><span class="badge">${badge.label}</span><time datetime="${html(entry.createdAt)}">${html(entry.createdAt)}</time></div>
        <h2><a href="${html(entry.href)}">${html(entry.name)}</a></h2>
        ${caption ? `<p class="caption">${html(caption)}</p>` : ""}
        <p class="summary">${html(badge.summary)}</p>
      </div>
    </article>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenWork photo rolls</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.card{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}header h1{margin:0 0 6px}.muted,time,.summary{color:#636c76}.card{display:grid;grid-template-columns:minmax(220px,40%) 1fr;gap:20px}.card.passed{border-left:6px solid #238636}.card.failed{border-left:6px solid #cf222e}.card.unvalidated{border-left:6px solid #9a6700}.card.legacy{border-left:6px solid #656d76}.thumb img,.empty{display:block;width:100%;aspect-ratio:16/10;object-fit:cover;border:1px solid #dfe2e8;border-radius:8px;background:#f6f7f9}.empty{display:grid;place-items:center;color:#636c76}.topline{display:flex;align-items:center;gap:10px}.badge{font-size:12px;font-weight:700}.passed .badge{color:#1a7f37}.failed .badge{color:#cf222e}.unvalidated .badge{color:#9a6700}.legacy .badge{color:#656d76}h2{margin:12px 0 6px}a{color:inherit}.caption{font-weight:600}@media(max-width:700px){.card{grid-template-columns:1fr}}
</style></head><body><header><h1>Photo rolls</h1><p class="muted">Evidence captured as the user experienced it, newest first.</p></header>${cards || '<p class="muted">No photo rolls found.</p>'}</body></html>\n`;
}

function summaryLine(roll: PhotoRollRecord): string {
  const summary = roll.summary;
  const icon = summary.ok ? "✅" : summary.failedFrames > 0 || summary.failedExpectations > 0 ? "❌" : "⚪";
  return `${icon} **${frameVerdict(roll)}** · ${summary.passedExpectations} expectations passed · ${summary.failedExpectations} failed`;
}

function renderFrame(frame: RollFrame, sequence: number, imageUrl: string | undefined): string {
  const fact = frame.fileName.length === 0;
  const marker = fact ? (frame.ok === false ? "❌ FAIL FACT" : "ℹ️ FACT") : frame.ok === false ? "❌ FAIL" : frame.ok === true ? "✅ PASS" : "⚪ UNVALIDATED";
  const lines = [`### ${marker} — ${sequence}. ${html(frame.caption)}`, ""];
  if (fact && frame.description) lines.push(html(frame.description), "");
  if (frame.results.length === 0) {
    lines.push("- ⚪ **UNVALIDATED** — no visual expectations recorded.");
  } else {
    for (const result of frame.results) {
      lines.push(`- ${result.passed ? "✅ **PASS**" : "❌ **FAIL**"} ${html(result.expectation)} — ${html(result.evidence)}`);
    }
  }
  if (imageUrl) {
    lines.push("", `<a href="${html(imageUrl)}"><img src="${html(imageUrl)}" alt="${html(frame.caption)}" width="700"></a>`);
  }
  return lines.join("\n");
}

function frameVerdict(roll: PhotoRollRecord): string {
  const frames = roll.frames.filter((frame) => frame.fileName.length > 0);
  const passed = frames.filter((frame) => frame.ok === true).length;
  const facts = roll.frames.length - frames.length;
  return `${passed}/${frames.length} frames passed${facts > 0 ? ` · ${facts} fact${facts === 1 ? "" : "s"}` : ""}`;
}

export function renderPrMarkdown(
  roll: PhotoRollRecord,
  urls: Record<string, string>,
  opts: RenderPrOptions = {},
): string {
  const title = opts.title ?? `Photo roll — ${roll.name}`;
  const lines = [
    "<!-- photo-roll -->",
    "<!-- fraimz -->",
    `## ${html(title)} — ${frameVerdict(roll)}`,
    "",
    summaryLine(roll),
  ];
  if (opts.notice) lines.push("", `> ${opts.notice}`);
  for (const [index, frame] of roll.frames.entries()) {
    lines.push("", renderFrame(frame, index + 1, urls[frame.fileName]));
  }
  const source = `evals/results/rolls/${roll.dir.split(/[\\/]/).at(-1) ?? roll.name}/roll.json`;
  lines.push(
    "",
    "---",
    `_Roll created ${html(roll.createdAt)} · Source: \`${html(source)}\`${opts.reproCommand ? ` · Repro: \`${html(opts.reproCommand)}\`` : ""}_`,
    "<!-- /photo-roll -->",
  );
  return lines.join("\n");
}
