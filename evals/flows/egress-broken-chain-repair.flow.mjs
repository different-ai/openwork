import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startEgressLab } from "../runner/labs/egress.mjs";
import { expectRuntimeTrust, expectVerdictNames, productDiagnosticsPrecondition } from "../runner/journeys/diagnostics.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "egress-broken-chain-repair";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME_HREF = pathToFileURL(join(ROOT, "apps", "desktop", "electron", "runtime.mjs")).href;
const COMMAND_TIMEOUT_MS = 45_000;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

function runNode(script, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--eval", script], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ status: -1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ status: typeof code === "number" ? code : -1, stdout, stderr });
    });
  });
}

function commandOutput(label, result) {
  return [
    `$ ${label}`,
    `exit: ${String(result.status)}`,
    "--- stdout ---",
    result.stdout.trim(),
    "--- stderr ---",
    result.stderr.trim(),
  ].join("\n").trim();
}

function parseJsonStdout(result) {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

function fetchProbeScript(url) {
  return `
    const url = ${JSON.stringify(url)};
    fetch(url).then(async (response) => {
      console.log(JSON.stringify({ ok: response.ok, status: response.status, body: await response.text() }));
      process.exit(response.ok ? 0 : 1);
    }).catch((error) => {
      console.log(JSON.stringify({ ok: false, name: error?.name ?? null, message: error?.message ?? String(error), causeCode: error?.cause?.code ?? null }));
      process.exit(1);
    });
  `;
}

function repairProbeScript(url, caPath, disabled) {
  return `
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { resolveSystemCaEnv } = await import(${JSON.stringify(RUNTIME_HREF)});
    const url = ${JSON.stringify(url)};
    const caPath = ${JSON.stringify(caPath)};
    const rootPem = await readFile(caPath, "utf8");
    const logs = [];
    const userDataDir = await mkdtemp(path.join(tmpdir(), "openwork-egress-chain-repair-"));
    const parentEnv = ${disabled ? "{ OPENWORK_DISABLE_CHAIN_REPAIR: '1' }" : "{}"};
    const caEnv = await resolveSystemCaEnv({
      tlsModule: { getCACertificates() { return []; } },
      userDataDir,
      parentEnv,
      logInfo(message) { logs.push(String(message)); },
      loadPlatformCertificates: async () => [rootPem],
      platformSourceName: "egress-lab-root",
      chainRepair: { origins: [url], rootsProvider: () => [rootPem] },
    });
    const child = spawnSync(process.execPath, ["--eval", ${JSON.stringify(fetchProbeScript(url))}], {
      env: { ...process.env, ...caEnv },
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    console.log(JSON.stringify({ caEnv, logs, child: { status: child.status, stdout: child.stdout, stderr: child.stderr } }));
  `;
}

function witness(ctx, condition, assertion, actual = "") {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, assertion);
}

function outputContainsChainError(value) {
  return /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|unable to get local issuer/i.test(value);
}

export default {
  id: FLOW_ID,
  title: "Broken TLS chains are repaired by the app-side AIA path and named by diagnostics",
  kind: "internal",
  requiresApp: false,
  precondition: (ctx) => productDiagnosticsPrecondition(ctx.env),
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        let lab;
        let plain;
        let repaired;
        let disabled;
        await ctx.prove("Leaf-only TLS chains fail plainly, product repair succeeds, the kill switch fails again, and OpenWork product diagnostics name the chain fault", {
          voiceover: vo[0],
          action: async () => {
            lab = await startEgressLab({ profile: "broken-chain" });
            plain = await runNode(fetchProbeScript(lab.url), { ...process.env, NODE_EXTRA_CA_CERTS: lab.caPath });
            repaired = await runNode(repairProbeScript(lab.url, lab.caPath, false));
            disabled = await runNode(repairProbeScript(lab.url, lab.caPath, true));
          },
          assert: async () => {
            try {
              const plainJson = parseJsonStdout(plain);
              const repairedJson = parseJsonStdout(repaired);
              const disabledJson = parseJsonStdout(disabled);
              ctx.output("Plain node fetch with root only", commandOutput("NODE_EXTRA_CA_CERTS=<root> node --eval <fetch>", plain));
              ctx.output("Runtime chain repair probe", commandOutput("node --eval <resolveSystemCaEnv repair probe>", repaired));
              ctx.output("Runtime chain repair disabled probe", commandOutput("node --eval <resolveSystemCaEnv disabled probe>", disabled));
              witness(ctx, plain.status !== 0, "plain node fetch fails when only the root is trusted and the server withholds the intermediate", JSON.stringify(plainJson));
              witness(ctx, outputContainsChainError(JSON.stringify(plainJson)), "plain failure names the first-certificate / missing-intermediate error", JSON.stringify(plainJson));
              witness(ctx, repaired.status === 0 && repairedJson?.child?.status === 0, "app-side resolveSystemCaEnv chain repair makes the child fetch succeed", JSON.stringify(repairedJson));
              witness(ctx, repairedJson?.logs?.some((line) => /chain repaired/.test(line)) === true, "repair logs say the AIA intermediate was added", JSON.stringify(repairedJson?.logs));
              witness(ctx, disabled.status === 0 && disabledJson?.child?.status !== 0, "OPENWORK_DISABLE_CHAIN_REPAIR=1 fails again", JSON.stringify(disabledJson));
              witness(ctx, outputContainsChainError(JSON.stringify(disabledJson)), "disabled repair preserves the missing-intermediate failure", JSON.stringify(disabledJson));
              await expectRuntimeTrust(ctx, { caPath: lab.caPath });
              await expectVerdictNames(ctx, { lab, expect: "broken-chain" });
            } finally {
              await lab?.stop();
            }
          },
        });
      },
    },
  ],
};
