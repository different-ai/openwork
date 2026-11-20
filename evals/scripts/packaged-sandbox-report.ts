import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "../worlds/packaged-sandbox-fixtures.ts";

const output = resolve(process.argv[2] ?? "reports/sandbox-mode/after");
const listedCases = [
  ["a", "Use: both operating systems and tag"], ["b", "Force: exact catalog and isolation"],
  ["c", "Live folders and revocation"], ["c-ro", "Read-only workspace"], ["d", "Empty cache and warm re-enable"],
  ["e", "Relaunch and warm reuse"], ["f1", "Use off mid-chat"], ["f2", "Force on mid-chat"], ["f3", "Force off mid-chat"],
  ["g", "VM crash, startup failure, Retry"], ["i-off", "Flag off"], ["i", "Flag on, both switches off"],
  ["j-use", "Real local repo task (Use)"], ["j-force", "Real local repo task (Force)"],
];
const json = (path: string) => readFile(path, "utf8").then((text): unknown => JSON.parse(text), () => null);
const md = (value: unknown) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");
const num = (value: unknown) => typeof value === "number" ? value : null;
const table = ["| Case | Fable 5.2 | GPT-6.2 Sol fast |", "|---|---|---|"];
const clocks = ["| Model / case | Milestone | ms |", "|---|---|---:|"];
const turns = ["| Model / case | Turn | Send → first inference (ms) | Send → first executable inference (ms) | Send → first tool done (ms) | First tool duration (ms) | Turn observed done (ms) | Tool calls | Den reads per path |", "|---|---|---:|---:|---:|---:|---:|---:|---|"];
const issues: string[] = [];
const prepFailures: string[] = [];
const providers = new Set<string>();
const ordinaryCatalogs = new Map<string, string>();
const dimensions = new Set<string>();
let full = 0, failed = 0, cleanup = 0, frames = 0;
for (const [id, title] of listedCases) {
  const cells = [];
  for (const model of ["fable", "sol"]) {
    if (id === "c-ro" && model === "sol") { cells.push("Not requested"); continue; }
    const casePath = `${model}/${id}`;
    const independent = id === "f2" || id === "c-ro" ? await json(join(output, "independent-followups", casePath, "report.json")) : null;
    const prefix = isRecord(independent) ? `independent-followups/${casePath}` : casePath;
    const where = join(output, prefix);
    const report = independent ?? await json(join(where, "report.json"));
    if (!isRecord(report)) { cells.push("No receipt"); continue; }
    const transcript = await json(join(where, "transcript.json"));
    const record = await json(join(where, "cleanup.json"));
    if (isRecord(record) && record.profileRemoved === true) cleanup++;
    const errors = Array.isArray(report.assertions) ? report.assertions.filter(isRecord).filter(item => !item.ok) : [];
    const problem = errors.map(item => String(item.name)).join("; ") || (typeof report.fatal === "string" ? report.fatal.split("\n")[0] : "");
    if (problem) {
      failed++;
      cells.push(`[FAIL](${prefix}/report.json): ${md(problem)}`);
      const reference = `[receipt](${prefix}/report.json), [transcript](${prefix}/transcript.json)${Array.isArray(report.frames) && report.frames.some(frame => isRecord(frame) && frame.name === "failure") ? `, [failure frame](${prefix}/failure.png)` : ""}`;
      const prep = errors.find(item => typeof item.name === "string" && item.name.endsWith(": no preparation error"));
      if (prep) {
        const progress = isRecord(report.measurements) ? report.measurements[String(prep.name).replace(": no preparation error", ": DOM progress samples")] : null;
        const last = Array.isArray(progress) ? progress.at(-1) : null;
        const errorAtMs = isRecord(last) ? last.atMs : null;
        prepFailures.push(`   - ${prefix}: ${md(errorAtMs)} ms to visible failure; ${md(Array.isArray(prep.detail) ? prep.detail.join(" ") : prep.detail)} [${reference}].`);
      } else issues.push(`**${prefix}** — ${md(problem)}. ${reference}.`);
    } else if (!isRecord(record) || record.profileRemoved !== true) {
      failed++;
      cells.push(`[Incomplete cleanup](${prefix}/report.json)`);
    } else { full++; cells.push(`[PASS](${prefix}/report.json)`); }
    const requests = Array.isArray(report.inference) ? report.inference.filter(isRecord) : [];
    if (id === "i" || id === "i-off") {
      const executable = requests.filter(request => Array.isArray(request.offeredTools) && request.offeredTools.length > 0);
      if (executable.length) ordinaryCatalogs.set(prefix, JSON.stringify([...new Set(executable.map(request => JSON.stringify([request.offeredTools, request.codeModeTools])))].sort()));
    }
    for (const request of requests) {
      if (typeof request.responseModel === "string") providers.add(`${request.requestedModel} → ${request.responseModel}; tier: ${request.responseServiceTier ?? "not returned"}`);
      if (Array.isArray(request.upstreamAttempts)) for (const attempt of request.upstreamAttempts.filter(isRecord)) if (attempt.status !== 200) providers.add(`${attempt.model}: HTTP ${attempt.status}`);
    }
    if (Array.isArray(report.frames)) for (const frame of report.frames.filter(isRecord)) { frames++; dimensions.add(`${frame.width}×${frame.height}`); }
    if (isRecord(report.timings)) for (const [label, value] of Object.entries(report.timings)) if (label !== "restartLaunchAt") clocks.push(`| ${prefix} | ${md(label)} | ${md(value)} |`);
    if (isRecord(report.measurements)) for (const [phase, value] of Object.entries(report.measurements)) {
      if (!isRecord(value) || !("sendToInferenceMs" in value)) continue;
      const phaseRequests = requests.filter(request => request.phase === phase);
      const firstInference = num(phaseRequests[0]?.receivedAt);
      const firstExecutable = num(phaseRequests.find(request => Array.isArray(request.offeredTools) && request.offeredTools.length > 0)?.receivedAt);
      const toFirstInference = num(value.sendToInferenceMs);
      const sent = firstInference == null || toFirstInference == null ? null : firstInference - toFirstInference;
      let toTool = num(value.sendToFirstToolCompleteMs);
      let duration = num(value.firstToolDurationMs);
      // Early receipts did not normalize v2's top-level tool.time. Recover exact timestamps from their preserved raw transcript.
      if ((duration === null || toTool === null) && Array.isArray(transcript)) {
        const turn = transcript.filter(isRecord).find(item => item.phase === phase && item.partial !== true);
        const body = turn?.body;
        if (isRecord(body) && isRecord(body.messages) && Array.isArray(body.messages.data)) {
          const rows = "cursor" in body.messages ? body.messages.data.toReversed() : body.messages.data;
          const time = rows.filter(isRecord).flatMap(row => Array.isArray(row.content) ? row.content.filter(isRecord) : [])
            .filter(part => part.type === "tool").map(part => part.time).filter(isRecord)
            .find(stamp => typeof stamp.ran === "number" && (sent === null || stamp.ran >= sent));
          if (time) {
            const start = num(time.ran), end = num(time.completed) ?? num(time.failed);
            if (start !== null && end !== null) duration = end - start;
            if (sent !== null && end !== null) toTool = end - sent;
          }
        }
      }
      turns.push(`| ${prefix} | ${md(phase)} | ${md(toFirstInference)} | ${md(sent === null || firstExecutable === null ? null : firstExecutable - sent)} | ${md(toTool)} | ${md(duration)} | ${md(value.observedTurnCompleteMs)} | ${md(value.toolCalls)} | ${md(JSON.stringify(value.denReadsByPath))} |`);
    }
    if (isRecord(report.notices)) for (const [name, value] of Object.entries(report.notices)) if (value) issues.push(`**${prefix}, ${md(name)} (observed copy)** — ${md(value)}. [Receipt](${prefix}/report.json).`);
  }
  table.push(`| ${id}: ${title} | ${cells.join(" | ")} |`);
}
const artifactLine = (await readFile(join(output, "matrix-run.log"), "utf8").catch(() => "")).split("\n").find(line => line.startsWith("Artifact ")) ?? "Artifact receipt unavailable.";
const proofLog = await readFile(join(output, "deterministic-proof.log"), "utf8").catch(() => "");
const lintLog = await readFile(join(output, "spec-lint.log"), "utf8").catch(() => "");
const proofRetry = await readFile(join(output, "deterministic-proof-migrate.log"), "utf8").catch(() => "");
const proofSummary = (log: string) => log.split("\n").filter(line => /placement:|Test Files |Tests |Test timed out|Error:/.test(line)).slice(0, 9).map(line => `- ${line.trim().slice(0, 400)}`).join("\n") || "- Pending or no terminal receipt.";
const proofResult = `${proofSummary(proofLog)}\n\nLocal schema-migration retry ([log](deterministic-proof-migrate.log)):\n${proofSummary(proofRetry)}`;
const nativeReceipt = await readFile(join(output, "native-runtime-diagnostic.txt"), "utf8").catch(() => "");
const subsequent = await readFile(join(output, "independent-followups.log"), "utf8").catch(() => "");
const followup = subsequent.split("\n").filter(line => /^(PASS|FAIL) .*(: (ongoing|pending|long chat|embedded server acknowledged|.*ran and returned|.*no preparation error|.*clocks|.*click)|\bnot)/.test(line));
const issuesOut = [...(prepFailures.length ? [`**Sandbox preparation never reached Ready on this artifact.** With a fresh profile and the verified rollout, open Settings → Permissions and click either switch. Expected: Preparing → Starting → Connecting your folders → Ready. Actual: the packaged Settings section displayed the following failure before a guest command could run. These are repeated observations of one blocker, not independent product bugs.\n${prepFailures.join("\n")}\n\nOn this Mac, kern.hv_support=1; the signed packaged msb has the Hypervisor entitlement. This establishes hardware capability and the entitlement, not a successful VM launch.`] : []), ...issues];
const baseline = ["fable", "sol"].map(model => {
  const on = ordinaryCatalogs.get(`${model}/i`), off = ordinaryCatalogs.get(`${model}/i-off`);
  return on && off ? `${model}: ${on === off ? "identical" : "different"} executable catalogs with flag off and flag on / both off` : `${model}: missing an ordinary-mode catalog`;
}).join("; ");
const lintResult = lintLog.split("\n").filter(line => /spec-lint:|spec\//.test(line)).map(line => `- ${line}`).join("\n") || "- Pending or no terminal receipt.";
await writeFile(join(output, "matrix.md"), `# Packaged OpenWork Sandbox matrix\n\n${artifactLine}\n\nOpenWork 0.18.70-sandbox.2, arm64; macOS 27.0 (26A428). Real packaged Electron/ASAR and microVM; signed-out rollout uses a loopback Den fixture. No production availability or signed-in organization behavior is claimed.\n\n**${full}/27 passed; ${failed}/27 failed or incomplete after a receipt; ${27 - full - failed}/27 have no receipt.** Case h is the separate Den proof.\n\n${table.join("\n")}\n\nBaseline catalog comparison: ${baseline}.\n\n## Timings\n\nSingle observations, not distributions. “Observed done” includes idle confirmation polling. First inference includes a possible concurrent title request; the executable request is also shown. No observed Den call means zero over the measured turn window; this is signed out.\n\n${clocks.join("\n")}\n\n${turns.join("\n")}\n\n## Provider observations\n\n${[...providers].map(value => `- ${value}`).join("\n") || "- None."}\n\n## Failure and notice receipts\n\n${issuesOut.map((item, i) => `${i + 1}. ${item}`).join("\n") || "No failure/notice receipt yet."}\n\n${nativeReceipt ? `[Native runtime diagnostic](native-runtime-diagnostic.txt) is separate from packaged renderer evidence. ${nativeReceipt.includes("have different Team IDs") ? "The same bundle's SDK resolved the bundled image and failed booting when macOS rejected the bundled firmware dylib: ‘mapping process and mapped file (non-platform) have different Team IDs’. This is a library-validation failure for the tested ad-hoc artifact, not evidence of unavailable hardware virtualization." : "See the receipt for the diagnostic result."}` : "No standalone native diagnostic receipt yet."}\n\n${followup.length ? `[Independent follow-up checks](independent-followups.log):\n${followup.map(line => `- ${line}`).join("\n")}` : ""}\n\n## Local commands and cleanup\n\n\`\`\`sh\nexport PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"\ninfisical run --silent --env dev -- node --conditions=development evals/scripts/packaged-sandbox-check.ts --app /tmp/owafter/OpenWork.app --model both --evidence-dir reports/sandbox-mode/after --cases i,i-off,a,b,c,d,e,f,g,j,c-ro\nMICROSANDBOX_LIVE=1 OPENWORK_EVAL_ELECTRON_BINARY=/tmp/owafter/OpenWork.app/Contents/MacOS/OpenWork OPENWORK_EVAL_ELECTRON_RESOURCES_PREPARED=1 OPENWORK_EVAL_MYSQL_URL=mysql://root@127.0.0.1:3306 pnpm evals:e2e packaged-sandbox --local --engine v2 --surface electron\npnpm --dir evals lint:specs\n\`\`\`\n\nDeterministic proof ([full log](deterministic-proof.log)):\n${proofResult}\n\nSpec lint ([full log](spec-lint.log)):\n${lintResult}\n\n${cleanup} profiles have removal receipts. Toggle choices, temporary folder grants, app state, and model tokens were scoped to disposable profiles. The harness released its machine-wide lock after stopping each owned launch. ${frames} full renderer PNG receipt(s); native dimensions: ${[...dimensions].join(", ") || "none"}. These are test evidence, not reviewed release screenshots.\n`);
