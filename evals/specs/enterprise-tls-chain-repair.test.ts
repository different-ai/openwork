import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { startEgressLab } from "@openwork/labs";
import { resolveSystemCaEnv } from "../../apps/desktop/electron/runtime.mjs";

// The classic corporate misconfig: a private-CA HTTPS server that serves its
// leaf certificate without the intermediate. This spec proves the desktop
// runtime repairs that chain using ONLY the activation origin that the
// enterprise sign-in gate stamps into the bootstrap file — the seam between
// the gate writing enterpriseActivation and resolveSystemCaEnv reading it —
// and that a kill switch or a mismatched stamped origin stays broken.
// chainRepair.origins is intentionally never passed anywhere in this file.

const chainErrorPattern = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|unable to verify the first certificate|unable to get local issuer/i;

function fetchProbeScript(url: string): string {
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

interface ChildFetchResult {
  status: number | null;
  output: string;
}

// Async spawn on purpose: the egress lab's TLS and AIA servers run inside this
// vitest process, so a spawnSync here would block the event loop and deadlock
// the child's handshake against the lab (the legacy flow spawned async too).
async function fetchLabInChild(url: string, env: NodeJS.ProcessEnv): Promise<ChildFetchResult> {
  const child = spawn(process.execPath, ["--eval", fetchProbeScript(url)], { env });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    output += chunk;
  });
  const status = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timer);
  return { status, output: output.trim() };
}

// Exactly the record the enterprise sign-in gate stamps after a successful
// grant exchange (enterprise-activation-gate.tsx, exchangeConfirmedGrant).
async function writeSignInStampedBootstrap(denBaseUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openwork-enterprise-activation-"));
  const bootstrapPath = join(dir, "desktop-bootstrap.json");
  const stamped = {
    baseUrl: denBaseUrl,
    requireSignin: true,
    enterpriseActivation: {
      activatedAt: new Date().toISOString(),
      denBaseUrl,
    },
  };
  await writeFile(bootstrapPath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  return bootstrapPath;
}

interface RepairAttempt {
  caEnv: NodeJS.ProcessEnv;
  logs: string[];
}

async function resolveCaEnvFromActivationRecord(options: {
  bootstrapPath: string;
  rootPem: string;
  parentEnv: NodeJS.ProcessEnv;
  tlsConnectImpl?: (connectOptions: { host: string; port: number }) => never;
}): Promise<RepairAttempt> {
  const userDataDir = await mkdtemp(join(tmpdir(), "openwork-chain-repair-spec-"));
  const logs: string[] = [];
  const caEnv: NodeJS.ProcessEnv = await resolveSystemCaEnv({
    tlsModule: { getCACertificates: () => [] },
    userDataDir,
    parentEnv: options.parentEnv,
    logInfo(message: unknown) {
      logs.push(String(message));
    },
    loadPlatformCertificates: async () => [options.rootPem],
    platformSourceName: "egress-lab-root",
    chainRepair: {
      bootstrapPath: options.bootstrapPath,
      rootsProvider: () => [options.rootPem],
      tlsConnectImpl: options.tlsConnectImpl,
    },
  });
  return { caEnv, logs };
}

async function reserveClosedPort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("port reservation did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("enterprise TLS chain repair unlocks exactly the sign-in-stamped activation origin", async ({ evidence }) => {
  await using lab = await startEgressLab({ profile: "broken-chain" });
  if (!lab.caPath || !lab.rootPem) throw new Error("egress lab did not expose its private root material");
  const labOrigin = new URL(lab.url).origin;

  // Arrange the activation origin the way the sign-in gate derives it: a
  // pasted junk URL is cleaned to the exact server origin before stamping.
  const { normalizeOrganizationServerInput } = await import(
    "../../apps/app/src/app/lib/organization-server-input"
  );
  const stampedOrigin = normalizeOrganizationServerInput(`${lab.url}/some/junk/path?x=1`);
  expect(stampedOrigin).toBe(labOrigin);
  if (stampedOrigin === null) throw new Error("normalizeOrganizationServerInput rejected the lab URL");
  const bootstrapPath = await writeSignInStampedBootstrap(stampedOrigin);

  // Claim 1 — the tough network is real: trusting only the private root is
  // not enough while the server withholds the intermediate.
  const plain = await fetchLabInChild(lab.url, { ...process.env, NODE_EXTRA_CA_CERTS: lab.caPath });
  expect(plain.status).not.toBe(0);
  expect(plain.output).toMatch(chainErrorPattern);
  const plainError = chainErrorPattern.exec(plain.output)?.[0] ?? "";
  evidence.recordAssertionEvidence(
    "The leaf-only corporate misconfig is a real failure before any repair",
    `normalizeOrganizationServerInput cleaned ${lab.url}/some/junk/path?x=1 to ${stampedOrigin}, the exact lab origin, and a child node fetch trusting only the private root (NODE_EXTRA_CA_CERTS) exited ${String(plain.status)} with "${plainError}"; it never reached the server body.`,
    true,
  );

  // Claim 2 — the seam: resolveSystemCaEnv reads the origin from the
  // sign-in-stamped bootstrap file (no chainRepair.origins anywhere) and
  // repairs the chain from the leaf's AIA URL.
  const repaired = await resolveCaEnvFromActivationRecord({
    bootstrapPath,
    rootPem: lab.rootPem,
    parentEnv: {},
  });
  expect(typeof repaired.caEnv.NODE_EXTRA_CA_CERTS).toBe("string");
  expect(repaired.logs.some((line) => /chain repaired/.test(line))).toBe(true);
  expect(repaired.logs.some((line) => line.includes(`chain repaired for ${labOrigin}`))).toBe(true);
  const healed = await fetchLabInChild(lab.url, { ...process.env, ...repaired.caEnv });
  expect(healed.status).toBe(0);
  evidence.recordAssertionEvidence(
    "Chain repair is driven by the activation record exactly as sign-in stamps it",
    `resolveSystemCaEnv received only the bootstrap file (baseUrl/requireSignin/enterpriseActivation as exchangeConfirmedGrant writes it), read ${labOrigin} from enterpriseActivation itself, logged "chain repaired for ${labOrigin}", exported NODE_EXTRA_CA_CERTS, and the same child fetch that just failed exited 0; no origins were ever passed to the repair call.`,
    true,
  );

  // Claim 3 — kill switch: with OPENWORK_DISABLE_CHAIN_REPAIR=1 the same
  // stamped record must not repair anything and the fetch fails again.
  const disabled = await resolveCaEnvFromActivationRecord({
    bootstrapPath,
    rootPem: lab.rootPem,
    parentEnv: { OPENWORK_DISABLE_CHAIN_REPAIR: "1" },
  });
  expect(disabled.logs.some((line) => /chain repair disabled/.test(line))).toBe(true);
  expect(disabled.logs.some((line) => /chain repaired/.test(line))).toBe(false);
  expect(typeof disabled.caEnv.NODE_EXTRA_CA_CERTS).toBe("string");
  const killSwitched = await fetchLabInChild(lab.url, { ...process.env, ...disabled.caEnv });
  expect(killSwitched.status).not.toBe(0);
  expect(killSwitched.output).toMatch(chainErrorPattern);
  evidence.recordAssertionEvidence(
    "The kill switch keeps the broken chain broken",
    `With OPENWORK_DISABLE_CHAIN_REPAIR=1 and the same activation record, the runtime logged "chain repair disabled", never logged "chain repaired", and the child fetch failed again with ${chainErrorPattern.exec(killSwitched.output)?.[0] ?? "a chain error"}; the exported bundle carried the root only.`,
    true,
  );

  // Claim 4 — a stamped origin that does not match the lab must never unlock
  // the lab server, and an http denBaseUrl must never even be probed.
  const closedPort = await reserveClosedPort();
  const mismatchedOrigin = `https://127.0.0.1:${closedPort}`;
  const mismatched = await resolveCaEnvFromActivationRecord({
    bootstrapPath: await writeSignInStampedBootstrap(mismatchedOrigin),
    rootPem: lab.rootPem,
    parentEnv: {},
  });
  expect(mismatched.logs.some((line) => line.includes(`chain repair skipped for ${mismatchedOrigin}`))).toBe(true);
  expect(mismatched.logs.some((line) => /chain repaired/.test(line))).toBe(false);
  expect(mismatched.logs.some((line) => line.includes(labOrigin))).toBe(false);
  const stillBroken = await fetchLabInChild(lab.url, { ...process.env, ...mismatched.caEnv });
  expect(stillBroken.status).not.toBe(0);
  expect(stillBroken.output).toMatch(chainErrorPattern);

  const probeTargets: string[] = [];
  const httpVariant = await resolveCaEnvFromActivationRecord({
    bootstrapPath: await writeSignInStampedBootstrap(`http://localhost:${closedPort}`),
    rootPem: lab.rootPem,
    parentEnv: {},
    tlsConnectImpl: (connectOptions) => {
      probeTargets.push(`${connectOptions.host}:${connectOptions.port}`);
      throw new Error("an http denBaseUrl must never be probed for chain repair");
    },
  });
  expect(probeTargets).toEqual([]);
  expect(httpVariant.logs.some((line) => /chain repair skipped: no activation record/.test(line))).toBe(true);
  expect(httpVariant.logs.some((line) => /chain repaired/.test(line))).toBe(false);
  const httpStillBroken = await fetchLabInChild(lab.url, { ...process.env, ...httpVariant.caEnv });
  expect(httpStillBroken.status).not.toBe(0);
  evidence.recordAssertionEvidence(
    "A mismatched or non-https stamped origin never unlocks the lab server",
    `An activation record naming ${mismatchedOrigin} only probed that origin ("chain repair skipped for ${mismatchedOrigin}"), never logged a repair, never mentioned ${labOrigin}, and the lab fetch stayed broken; an http:// denBaseUrl produced zero TLS probes with "chain repair skipped: no activation record", and the lab fetch stayed broken there too.`,
    true,
  );
});
