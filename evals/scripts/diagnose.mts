import { probeTls } from "@openwork/behaviors";
import { diagnoseTls, type TlsVersionFacts } from "@openwork/matchers";

function usage(): never {
  throw new Error("Usage: node evals/scripts/diagnose.mts <origin> [--insecure-ca <pemPath>]");
}

const args = process.argv.slice(2);
const origin = args[0];
if (!origin) usage();
let ca: string | undefined;
for (let index = 1; index < args.length; index += 1) {
  if (args[index] !== "--insecure-ca") usage();
  const pemPath = args[index + 1];
  if (!pemPath) usage();
  ca = process.getBuiltinModule("node:fs").readFileSync(pemPath, "utf8");
  index += 1;
}

const url = new URL(origin);
const tls = await probeTls({
  host: url.hostname,
  port: Number(url.port || 443),
  servername: url.hostname,
  ca,
});
function printVersion(label: string, facts: TlsVersionFacts): void {
  const handshake = facts.handshakeOk ? "ok" : (facts.stalled ? "STALLED" : "FAILED");
  const chain = facts.handshakeOk
    ? (facts.chainVerified ? "verified" : `UNTRUSTED (${facts.errorCode ?? "unauthorized"})`)
    : "not checked";
  console.log(`${label}: handshake ${handshake} / chain ${chain}`);
}
printVersion("TLS 1.2", tls.tls12);
printVersion("TLS 1.3", tls.tls13);
const findings = [diagnoseTls(tls)];
for (const finding of findings) {
  console.log(`${finding.ok ? "ok" : "FAIL"} tls ${finding.code}`);
  if (!finding.ok) {
    console.log(`  ${finding.summary}`);
    console.log(`  Action: ${finding.action}`);
  }
}
console.log(JSON.stringify({ origin: url.origin, tls, findings }, null, 2));
if (findings.some((finding) => !finding.ok)) process.exitCode = 1;
