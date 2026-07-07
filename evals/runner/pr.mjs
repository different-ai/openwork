/**
 * fraimz on the PR: render the frame-by-frame proof as a PR comment and post
 * it with `gh`. The comment is the follow-along demo: each frame reads as
 * claim → voiceover → assertions → validated screenshot; `fraimz.html` in the
 * run directory stays the full artifact.
 *
 * Frame screenshots are uploaded to Vercel Blob (see the `upload-photo`
 * skill) so they render inline in the PR comment. Requires
 * `BLOB_READ_WRITE_TOKEN`, falling back to Infisical when unset.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const BLOB_API_BASE = "https://blob.vercel-storage.com";

function resolveBlobToken() {
  const fromEnv = process.env.BLOB_READ_WRITE_TOKEN;
  if (fromEnv) return fromEnv;
  const result = spawnSync(
    "infisical",
    ["secrets", "get", "BLOB_READ_WRITE_TOKEN", "--plain", "--silent"],
    { encoding: "utf8" },
  );
  const token = result.status === 0 && !result.error ? result.stdout.trim() : "";
  return token.length > 0 ? token : null;
}

function contentTypeFor(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export function renderPrComment(report, imageUrls = null) {
  const verdict = report.summary.failed > 0 ? "❌ FAILED" : "✅ PASSED";
  const lines = [
    `## fraimz — ${verdict}`,
    "",
    `${report.summary.passed} passed · ${report.summary.failed} failed · ${report.summary.skipped} skipped — run \`${report.runId}\``,
    "",
    `Full frame proof with validated screenshots: \`evals/results/${report.runId}/fraimz.html\` (re-run: \`pnpm fraimz ${report.flows.map((flow) => `--flow ${flow.id}`).join(" ")}\`)`,
    "",
  ];
  for (const flow of report.flows) {
    const icon = flow.status === "passed" ? "✅" : flow.status === "skipped" ? "⏭️" : "❌";
    lines.push(`### ${icon} ${flow.id} — ${flow.title}`);
    if (flow.kind) lines.push(`_${flow.kind === "user-facing" ? "User-facing flow demo" : "Internal demo"}_`);
    if (flow.skipReason) lines.push(`Skipped: ${flow.skipReason}`);
    lines.push("");
    let frame = 0;
    for (const step of flow.steps ?? []) {
      const evidenceItems = step.evidence ?? [];
      const opened = new Set();
      let openClaim = null;
      let narrated = null;
      for (const [index, evidence] of evidenceItems.entries()) {
        if (evidence.type === "claim") {
          const key = evidence.name ?? evidence.claim;
          const claim = evidence.claim ?? evidence.name;
          if (evidence.status === "running") {
            const closed = evidenceItems.slice(index + 1).some((item) => {
              const itemKey = item.name ?? item.claim;
              return item.type === "claim" && item.status === "passed" && itemKey === key;
            });
            frame += 1;
            lines.push(`${frame}. ${closed ? "" : "❌ "}**${claim}**`);
            opened.add(key);
            openClaim = claim ?? null;
            narrated = null;
            if (evidence.voiceover) {
              lines.push(`   > 🎙 ${evidence.voiceover}`);
              narrated = evidence.voiceover;
            }
          } else if (evidence.status === "passed" && !opened.has(key)) {
            frame += 1;
            lines.push(`${frame}. **${claim}**`);
            opened.add(key);
            openClaim = claim ?? null;
            narrated = null;
            if (evidence.voiceover) {
              lines.push(`   > 🎙 ${evidence.voiceover}`);
              narrated = evidence.voiceover;
            }
          }
        }
        if (evidence.type === "assertion") {
          lines.push(`   - ${evidence.status === "passed" ? "✅" : "❌"} ${evidence.assertion}`);
        }
        if (evidence.type === "frame") {
          if (evidence.claim && evidence.claim !== openClaim) {
            frame += 1;
            lines.push(`${frame}. **${evidence.claim}**`);
            openClaim = evidence.claim;
            narrated = null;
          }
          if (evidence.voiceover && evidence.voiceover !== narrated) {
            lines.push(`   > 🎙 ${evidence.voiceover}`);
            narrated = evidence.voiceover;
          }
          const failed = (evidence.validations ?? []).filter((validation) => !validation.passed);
          lines.push(
            `   - 📸 \`${evidence.file}\` — ${failed.length === 0 ? `${(evidence.validations ?? []).length} validations passed` : `FAILED: ${failed.map((validation) => validation.label).join(", ")}`}`,
          );
          if (imageUrls?.[evidence.file]) {
            lines.push("", `   <img src="${imageUrls[evidence.file]}" alt="${evidence.file}" width="700">`, "");
          }
        }
      }
      if (step.status === "failed") lines.push(`   - ❌ **${step.name}** — ${step.error}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function uploadRunImages(report, outDir) {
  const files = [];
  const seen = new Set();
  for (const flow of report.flows) {
    for (const step of flow.steps ?? []) {
      for (const evidence of step.evidence ?? []) {
        if (evidence.type === "frame" && !seen.has(evidence.file) && existsSync(join(outDir, evidence.file))) {
          seen.add(evidence.file);
          files.push(evidence.file);
        }
      }
    }
  }
  if (files.length === 0) return null;

  const token = resolveBlobToken();
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set and could not be fetched from Infisical (`infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent`) — " +
        "run `infisical login` once, or export it: " +
        'export BLOB_READ_WRITE_TOKEN="$(infisical secrets get BLOB_READ_WRITE_TOKEN --plain --silent)"',
    );
  }

  const imageUrls = {};
  for (const file of files) {
    const pathname = `fraimz/${report.runId}/${encodeURIComponent(basename(file))}`;
    const response = await fetch(`${BLOB_API_BASE}/${pathname}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-content-type": contentTypeFor(file),
        // Deterministic pathname: each run id + file name is already unique,
        // so a random suffix would only make the URL harder to predict.
        "x-add-random-suffix": "0",
      },
      body: readFileSync(join(outDir, file)),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`Vercel Blob upload failed (${response.status}) for ${file}: ${detail}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Vercel Blob upload for ${file}: response was not JSON`);
    }
    if (!payload || typeof payload.url !== "string" || payload.url.length === 0) {
      throw new Error(`Vercel Blob upload for ${file}: response did not include a url`);
    }

    imageUrls[file] = payload.url;
  }
  return imageUrls;
}

/**
 * Post the comment with `gh pr comment`. `prNumber` may be null: gh then
 * targets the PR of the current branch. Returns { posted, detail }.
 */
export async function postPrComment(report, { outDir, prNumber = null } = {}) {
  let imageUrls = null;
  let uploadError = null;
  try {
    imageUrls = await uploadRunImages(report, outDir);
  } catch (error) {
    uploadError = error instanceof Error ? error.message : String(error);
  }
  const body = `${renderPrComment(report, imageUrls)}${uploadError ? `\n\n_(screenshot upload failed: ${uploadError} — images available in the run directory)_` : ""}`;
  const bodyPath = join(outDir, "pr-comment.md");
  await writeFile(bodyPath, body);
  const args = ["pr", "comment", ...(prNumber ? [String(prNumber)] : []), "--body-file", bodyPath];
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `gh exited ${result.status}`;
    return { posted: false, bodyPath, detail };
  }
  return { posted: true, bodyPath, detail: result.stdout.trim() };
}
