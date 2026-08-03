import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shot } from "./screenshot.ts";
import type { SeenFacts, SeenResult } from "./validate.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

interface RollFrame {
  caption: string;
  fileName: string;
  hash: string;
  route: string;
  at: string;
  description: string;
  model: string;
  ok: boolean | null;
  results: SeenResult[];
}

interface StoredFrame extends RollFrame {
  sequence: number;
  png: Buffer | null;
  claimKey: string | null;
}

export interface Tape {
  readonly dir: string;
  recordTake(shot: Shot): string;
  claim(shotHash: string, seen: SeenFacts): string;
  fact(claim: string, evidence: string, passed: boolean): void;
  close(): Promise<string>;
  [Symbol.asyncDispose](): Promise<void>;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "frame";
}

function html(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fileName(sequence: number, caption: string): string {
  return `${String(sequence).padStart(2, "0")}-${slug(caption)}.png`;
}

function frameCaption(name: string, sequence: number, seen?: SeenFacts): string {
  return seen?.results[0]?.expectation.trim() || `${name} frame ${sequence}`;
}

function claimKey(seen: SeenFacts): string {
  return JSON.stringify(seen.results.map((result) => result.expectation.trim()));
}

function gitValue(args: string[]): string {
  const result = spawnSync("git", ["rev-parse", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return result.status === 0 && !result.error ? result.stdout.trim() : "";
}

function rollFrame(frame: StoredFrame): RollFrame {
  return {
    caption: frame.caption,
    fileName: frame.fileName,
    hash: frame.hash,
    route: frame.route,
    at: frame.at,
    description: frame.description,
    model: frame.model,
    ok: frame.ok,
    results: frame.results,
  };
}

function renderFrame(frame: RollFrame): string {
  return `
      <article class="frame ${frame.ok === true ? "passed" : frame.ok === false ? "failed" : "unvalidated"}">
        <h2>${html(frame.caption)}</h2>
        <p class="meta">${html(frame.route)} · ${html(frame.at)}${frame.model ? ` · ${html(frame.model)}` : ""}</p>
        ${frame.fileName ? `<img src="${html(frame.fileName)}" alt="${html(frame.caption)}">` : ""}
        <p>${html(frame.description || "Not vision-validated.")}</p>
        <ul>${frame.results.map((result) => `<li class="${result.passed ? "pass" : "fail"}"><strong>${result.passed ? "PASS" : "FAIL"}</strong> ${html(result.expectation)} — ${html(result.evidence)}</li>`).join("")}</ul>
      </article>`;
}

export function openTape(meta: { name: string; outDir?: string }): Tape {
  const { name } = meta;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = meta.outDir ?? join(REPO_ROOT, "evals", "results", "rolls", `${stamp}-${slug(name)}`);
  const frames: StoredFrame[] = [];
  const createdAt = new Date().toISOString();
  const gitSha = gitValue(["HEAD"]);
  const branch = gitValue(["--abbrev-ref", "HEAD"]);
  let nextSequence = 1;
  let closing: Promise<string> | null = null;

  const assertOpen = (): void => {
    if (closing) throw new Error(`Cannot record evidence after tape "${name}" is closed.`);
  };

  const close = (): Promise<string> => {
    if (closing) return closing;
    closing = (async () => {
      await mkdir(dir, { recursive: true });
      for (const frame of frames) {
        if (frame.png) await writeFile(join(dir, frame.fileName), frame.png);
      }
      const orderedFrames = [
        ...frames.filter((frame) => frame.ok !== null),
        ...frames.filter((frame) => frame.ok === null),
      ].map(rollFrame);
      const expectationResults = orderedFrames.flatMap((frame) => frame.results);
      const summary = {
        ok: orderedFrames.length > 0 && orderedFrames.every((frame) => frame.ok === true),
        totalFrames: orderedFrames.length,
        passedFrames: orderedFrames.filter((frame) => frame.ok === true).length,
        failedFrames: orderedFrames.filter((frame) => frame.ok === false).length,
        unvalidatedFrames: orderedFrames.filter((frame) => frame.ok === null).length,
        passedExpectations: expectationResults.filter((result) => result.passed).length,
        failedExpectations: expectationResults.filter((result) => !result.passed).length,
      };
      const closedAt = new Date().toISOString();
      const payload = { name, dir, createdAt, closedAt, gitSha, branch, summary, frames: orderedFrames };
      const claimedFrames = orderedFrames.filter((frame) => frame.ok !== null).map(renderFrame).join("");
      const unclaimedFrames = orderedFrames.filter((frame) => frame.ok === null);
      const unclaimedMarkup = unclaimedFrames.length > 0
        ? `<details class="unclaimed-takes unvalidated"><summary>unclaimed takes (${unclaimedFrames.length})</summary>${unclaimedFrames.map(renderFrame).join("")}</details>`
        : "";
      const index = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${html(name)} photo roll</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:1100px;margin:40px auto;padding:0 20px;background:#f6f7f9;color:#17191d}header,.frame,details{background:white;border:1px solid #dfe2e8;border-radius:12px;padding:20px;margin:0 0 24px}.frame.passed{border-left:6px solid #238636}.frame.failed{border-left:6px solid #cf222e}.frame.unvalidated,details.unvalidated{border-left:6px solid #9a6700}details .frame{margin-top:20px}summary{cursor:pointer;font-weight:700}img{display:block;width:100%;height:auto;border:1px solid #dfe2e8;border-radius:8px}.meta{color:#636c76}.pass strong{color:#1a7f37}.fail strong{color:#cf222e}li{margin:8px 0}
</style></head><body><header><h1>${html(name)}</h1><p>${summary.passedFrames}/${summary.totalFrames} frames passed; ${summary.failedFrames} failed; ${summary.unvalidatedFrames} unvalidated. ${summary.passedExpectations} expectations passed and ${summary.failedExpectations} failed.</p></header>${claimedFrames}${unclaimedMarkup}</body></html>\n`;
      await writeFile(join(dir, "roll.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await writeFile(join(dir, "index.html"), index, "utf8");
      return join(dir, "index.html");
    })();
    return closing;
  };

  return {
    dir,
    recordTake(shot) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = frameCaption(name, sequence);
      const takeFileName = fileName(sequence, caption);
      frames.push({
        caption,
        fileName: takeFileName,
        hash: shot.hash,
        route: shot.route,
        at: shot.at,
        description: "",
        model: "",
        ok: null,
        results: [],
        sequence,
        png: shot.png,
        claimKey: null,
      });
      return join(dir, takeFileName);
    },
    claim(shotHash, seen) {
      assertOpen();
      const key = claimKey(seen);
      const claimed = frames.find((frame) => frame.png !== null && frame.hash === shotHash && frame.claimKey !== null);
      if (claimed) {
        const caption = frameCaption(name, claimed.sequence, seen);
        if (claimed.claimKey !== key) {
          throw new Error(`Screenshot pixels for "${caption}" already back the different claim "${claimed.caption}".`);
        }
        claimed.caption = caption;
        claimed.fileName = fileName(claimed.sequence, caption);
        claimed.description = seen.description;
        claimed.model = seen.model;
        claimed.ok = seen.ok;
        claimed.results = seen.results;
        return join(dir, claimed.fileName);
      }
      const take = frames.find((frame) => frame.png !== null && frame.hash === shotHash && frame.claimKey === null);
      if (!take) throw new Error(`No recorded take has screenshot hash "${shotHash}".`);
      const caption = frameCaption(name, take.sequence, seen);
      take.caption = caption;
      take.fileName = fileName(take.sequence, caption);
      take.description = seen.description;
      take.model = seen.model;
      take.ok = seen.ok;
      take.results = seen.results;
      take.claimKey = key;
      return join(dir, take.fileName);
    },
    fact(claim, evidence, passed) {
      assertOpen();
      const sequence = nextSequence;
      nextSequence += 1;
      const caption = claim.trim() || `${name} fact ${sequence}`;
      frames.push({
        caption,
        fileName: "",
        hash: "",
        route: "",
        at: new Date().toISOString(),
        description: evidence,
        model: "",
        ok: passed,
        results: [{ expectation: caption, evidence, passed }],
        sequence,
        png: null,
        claimKey: JSON.stringify([caption]),
      });
    },
    close,
    async [Symbol.asyncDispose]() {
      await close();
    },
  };
}
