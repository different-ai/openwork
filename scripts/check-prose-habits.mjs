import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addedLinesFromDiff } from "./check-code-habits.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skipped = /(?:^|\/)(?:node_modules|dist|build|vendor|fixtures|__fixtures__)\/|(?:^|\/)CHANGELOG\.md$/;

export const rules = [
  {
    rule: "no-dash",
    test: (line) => /[–—]|\S\s+-{1,2}\s+\S/.test(line
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
      .replace(/^\s*\|.*\|\s*$/, (row) => row.replace(/\|\s*:?-+:?\s*(?=\|)/g, "|").replace(/\|\s*[–—-]\s*(?=\|)/g, "|"))
      .replace(/(\d)–(?=\d)/g, "$1")),
    message: "No em dashes, en dashes or hyphens used as dashes. Use a period or a comma.",
  },
  {
    rule: "no-ai-vocabulary",
    test: (line) => /\b(?:additionally|crucial|delve[sd]?|delving|enhanc(?:e|es|ed|ing)|foster(?:s|ed|ing)?|pivotal|showcas(?:e|es|ed|ing)|testament|vibrant|seamless(?:ly)?|robust)\b/i.test(line),
    message: "No AI vocabulary (additionally, crucial, delve, enhance, foster, pivotal, showcase, testament, vibrant, seamless, robust). Say the plain fact.",
  },
  {
    rule: "no-serves-as",
    test: (line) => /\b(?:serves?|serving|stands?) as\b|\bboasts?\b/i.test(line),
    message: "Say \"is\" or \"has\", not \"serves as\", \"stands as\" or \"boasts\".",
  },
  {
    rule: "no-not-just",
    test: (line) => /\bnot (?:just|only|merely)\b[^.]{1,120}\bbut\b/i.test(line),
    message: "No \"not just X, but Y\". State the point.",
  },
  {
    rule: "no-chatbot-phrase",
    test: (line) => /\b(?:I hope this helps|great question|let me know if|feel free to|happy to help|as an AI)\b|\bcertainly!/i.test(line),
    message: "No chatbot phrases. Docs are read later, not replied to.",
  },
  {
    rule: "no-wordy-phrase",
    test: (line) => /\bin order to\b|\butili[sz](?:e|es|ed|ing|ation)\b|\bleverag(?:e|es|ed|ing)\b/i.test(line),
    message: "Use \"to\" for \"in order to\" and \"use\" for \"utilize\" or \"leverage\".",
  },
  {
    rule: "no-curly-quotes",
    test: (line) => /[‘’“”]/.test(line),
    message: "Use straight quotes (' and \"), not curly ones.",
  },
  {
    rule: "no-filler-word",
    test: (line) => /\b(?:simply|easy|easily|please)\b|\betc\./i.test(line),
    message: "Cut \"simply\", \"easy\", \"please\" and \"etc.\". Say what to do, or list every item.",
  },
];

export function proseLines(content) {
  const lines = content.split("\n");
  const result = [];
  let fence;
  let comment = false;
  lines.forEach((raw, index) => {
    const fenceMatch = raw.match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = undefined;
      return;
    }
    if (fenceMatch) {
      fence = fenceMatch[1];
      return;
    }
    if (/^(?: {4}|\t)/.test(raw) && (index === 0 || lines[index - 1].trim() === "" || /^(?: {4}|\t)/.test(lines[index - 1]))
      && !/^\s*(?:[-*+]|\d+\.)\s/.test(raw)) return;
    let line = raw;
    if (comment || line.includes("<!--")) {
      const end = line.indexOf("-->");
      if (comment && end === -1) return;
      line = comment ? line.slice(end + 3) : line;
      comment = false;
      line = line.replace(/<!--.*?-->/g, "");
      const open = line.indexOf("<!--");
      if (open !== -1) {
        line = line.slice(0, open);
        comment = true;
      }
    }
    line = line
      .replace(/(`+)[\s\S]*?\1/g, "")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/\bhttps?:\/\/\S+/g, "");
    result.push({ line: index + 1, text: line });
  });
  return result;
}

export function checkProse(file, content, addedLines) {
  const findings = [];
  for (const { line, text } of proseLines(content)) {
    if (!addedLines.has(line)) continue;
    for (const { rule, test, message } of rules) {
      if (test(text)) findings.push({ file, line, rule, message });
    }
  }
  return findings;
}

export function isProseFile(file) {
  return file.endsWith(".md") && !skipped.test(file);
}

function git(...args) {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

export async function main(args = process.argv.slice(2)) {
  const baseIndex = args.indexOf("--base");
  if (args.some((arg, index) => arg !== "--base" && index !== baseIndex + 1) || (baseIndex !== -1 && !args[baseIndex + 1])) {
    throw new Error("Usage: node scripts/check-prose-habits.mjs [--base <ref>]");
  }
  let base;
  try {
    base = baseIndex !== -1
      ? git("rev-parse", "--verify", "--end-of-options", `${args[baseIndex + 1]}^{commit}`).trim()
      : git("merge-base", "HEAD", "origin/dev").trim();
  } catch {
    console.log("Prose habits: skipped; no base commit could be resolved (use --base <ref> or fetch origin/dev).");
    return;
  }
  const added = addedLinesFromDiff(git("diff", "-U0", "--no-renames", base, "--", "*.md"));
  const untracked = new Set(git("ls-files", "--others", "--exclude-standard", "-z", "--", "*.md").split("\0").filter(Boolean));
  const findings = [];
  for (const file of [...new Set([...added.keys(), ...untracked])].sort()) {
    if (!isProseFile(file)) continue;
    let content;
    try {
      content = await readFile(path.join(root, file), "utf8");
    } catch {
      continue;
    }
    const lines = untracked.has(file)
      ? new Set(content.split("\n").map((_, index) => index + 1))
      : added.get(file) ?? new Set();
    findings.push(...checkProse(file, content, lines));
  }
  for (const finding of findings) console.error(`${finding.file}:${finding.line} [${finding.rule}] ${finding.message}`);
  console.log(`Prose habits: ${findings.length} violation(s).`);
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
