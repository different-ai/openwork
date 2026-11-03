import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose"
import { cloudShellCommand, enrollmentAudience, gcpBundleUrlSchema, heartbeatAudience, serviceAccountEmail, serviceAccountName, verifyGcpIdentity, type GcpLaunch } from "@openwork/managed-deployments/gcp"
import { gcpTargetSchema, healthReportSchema, managedDeploymentInputSchema, managedDeploymentSchema } from "@openwork/managed-deployments/schema"

const deploymentId = "12345678-1234-4000-8000-000000000001"
const runId = "00000000-0000-4000-8000-000000000002"
const now = new Date("2026-10-13T12:00:00Z")
const issued = now.getTime() / 1000
const target = gcpTargetSchema.parse({ projectId: "openwork-test", projectNumber: "123456789012", region: "us-central1", dnsZoneName: "openwork-zone" })
const origin = "https://api.example.com"
const challenge = "a".repeat(64)
const audience = enrollmentAudience(origin, deploymentId, runId, challenge)
const email = serviceAccountEmail(deploymentId, target.projectId, "runner")
const keys = await generateKeyPair("RS256")
const jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256" }
const keyResolver = createLocalJWKSet({ keys: [jwk] })
const claims = { iss: "https://accounts.google.com", sub: "12345678901234567890", aud: audience, email, email_verified: true, iat: issued, exp: issued + 3600 }
function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey)
}
async function verify(idToken: string, expectedAudience = audience, expectedEmail = email) {
  return verifyGcpIdentity({ idToken, audience: expectedAudience, email: expectedEmail, now, keyResolver })
}
const launch: GcpLaunch = {
  deploymentId, runId, challenge, target, domainName: "openwork.example.com", ownerEmail: "o'connor@example.com", size: "small",
  release: { templateUrl: "https://storage.googleapis.com/openwork-test/releases/gcp/1.0.0/tutorial.md?generation=123455", bundleUrl: "https://storage.googleapis.com/openwork-test/releases/gcp/1.0.0/bundle.tar.gz?generation=123456", bundleSha256: "b".repeat(64), version: "1.0.0", apiOrigin: origin },
}

test("GCP targets are strict and provider-tagged", () => {
  const input = { name: "Test", provider: "gcp", target, domainName: launch.domainName, ownerEmail: launch.ownerEmail }
  assert.equal(managedDeploymentInputSchema.parse(input).provider, "gcp")
  for (const change of [{ projectId: "bad'project" }, { projectNumber: "1e12" }, { region: "mars1" }, { dnsZoneName: "zone;echo hi" }, { extra: "ignored" }]) {
    assert.equal(gcpTargetSchema.safeParse({ ...target, ...change }).success, false)
  }
  // A stored AWS target cannot be returned under a GCP discriminator.
  assert.equal(managedDeploymentSchema.safeParse({ ...input, target: { accountId: "123456789012", region: "us-east-1", route53ZoneId: "ZTEST" } }).success, false)
  assert.equal(serviceAccountName(deploymentId, "runner"), "ow-123456781234-runner")
  assert.equal(email, "ow-123456781234-runner@openwork-test.iam.gserviceaccount.com")
  assert.notEqual(email, serviceAccountEmail(deploymentId, target.projectId, "health"))
})

test("Google signed identity requires exact verified email, issuer, audience and fresh timestamps", async () => {
  assert.equal((await verify(await token())).toISOString(), now.toISOString())
  for (const override of [
    { iss: "https://attacker.example.com" }, { aud: "other" }, { aud: [audience, "other"] }, { email: "admin@openwork-test.iam.gserviceaccount.com" },
    { email: serviceAccountEmail(deploymentId, "another-project", "runner") },
    { email: serviceAccountEmail(deploymentId, target.projectId, "health") },
    { email_verified: false }, { email_verified: "true" }, { iat: issued - 61 }, { iat: issued + 1 },
    { iat: undefined }, { iat: issued - 0.5 }, { exp: undefined }, { exp: issued }, { exp: issued + 0.5 },
    { exp: issued + 3601 }, { sub: undefined }, { sub: "" }, { nbf: issued + 1 },
  ]) await assert.rejects(verify(await token(override)))
  const stranger = await generateKeyPair("RS256")
  const forged = await new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(stranger.privateKey)
  await assert.rejects(verify(forged))
})

test("enrollment and health share a 60-second issuance window, zero future skew and strict expiry", async () => {
  const healthEmail = serviceAccountEmail(deploymentId, target.projectId, "health")
  const healthAudience = heartbeatAudience(origin, deploymentId, "c".repeat(64))
  for (const identity of [{ aud: audience, email }, { aud: healthAudience, email: healthEmail }]) {
    const recent = await token({ ...identity, iat: issued - 60, exp: issued + 3540 })
    assert.equal((await verify(recent, identity.aud, identity.email)).getTime(), now.getTime() - 60_000)
    for (const timestamps of [{ iat: issued - 61 }, { iat: issued + 1 }, { iat: issued - 10, exp: issued }]) {
      await assert.rejects(verify(await token({ ...identity, ...timestamps }), identity.aud, identity.email))
    }
  }
})

test("challenge, deployment, run, origin and exact health body are cryptographically bound", async () => {
  const enrolled = await token()
  for (const aud of [
    enrollmentAudience(origin, deploymentId, runId, "b".repeat(64)),
    enrollmentAudience(origin, runId, deploymentId, challenge),
    enrollmentAudience("https://another.example.com", deploymentId, runId, challenge),
  ]) await assert.rejects(verify(enrolled, aud))
  const raw = '{"nonce":"' + "a".repeat(32) + '","checks":[{"id":"api_health","status":"ok"}]}'
  const digest = (body: string) => createHash("sha256").update(body).digest("hex")
  const healthAudience = heartbeatAudience(origin, deploymentId, digest(raw))
  const healthEmail = serviceAccountEmail(deploymentId, target.projectId, "health")
  const healthToken = await token({ aud: healthAudience, email: healthEmail })
  assert.equal((await verify(healthToken, healthAudience, healthEmail)).getTime(), now.getTime())
  await assert.rejects(verify(healthToken))
  await assert.rejects(verify(healthToken, heartbeatAudience(origin, deploymentId, digest(raw + " ")), healthEmail))
  await assert.rejects(verify(healthToken, heartbeatAudience(origin, deploymentId, digest(raw.replace("a".repeat(32), "b".repeat(32)))), healthEmail))
  await assert.rejects(verify(healthToken, healthAudience, email))
})

test("distinct valid heartbeat proofs can share an iat second; replay ordering stays strict", async () => {
  const healthEmail = serviceAccountEmail(deploymentId, target.projectId, "health")
  async function measured(nonce: string, iat: number, at = now) {
    const raw = JSON.stringify({ nonce, checks: [{ id: "api_health", status: "ok" }] })
    const aud = heartbeatAudience(origin, deploymentId, createHash("sha256").update(raw).digest("hex"))
    const idToken = await token({ aud, email: healthEmail, iat, exp: iat + 3600 })
    const signedAt = await verifyGcpIdentity({ idToken, audience: aud, email: healthEmail, now: at, keyResolver })
    return { idToken, aud, signedAt }
  }
  const first = await measured("a".repeat(32), issued)
  const simultaneous = await measured("b".repeat(32), issued)
  assert.notEqual(first.idToken, simultaneous.idToken)
  assert.notEqual(first.aud, simultaneous.aud)
  assert.equal(first.signedAt.getTime(), simultaneous.signedAt.getTime())
  // The server transaction deliberately rejects >=, including identical proof
  // replays and genuinely distinct same-second measurements. Do not weaken it.
  const stale = (incoming: Date) => first.signedAt >= incoming
  assert.equal(stale(simultaneous.signedAt), true)
  assert.equal(stale(first.signedAt), true)
  assert.equal(stale((await measured("c".repeat(32), issued - 1)).signedAt), true)
  const fresh = await measured("d".repeat(32), issued + 1, new Date(now.getTime() + 1000))
  assert.equal(stale(fresh.signedAt), false)
})

test("health nonce is optional for AWS compatibility but bounded to exactly 32 lowercase hex characters", () => {
  const report = { checks: [{ id: "api_health", status: "ok" }] }
  assert.equal(healthReportSchema.safeParse(report).success, true)
  for (const nonce of ["0".repeat(32), "abcdef0123456789".repeat(2)]) {
    assert.equal(healthReportSchema.parse({ ...report, nonce }).nonce, nonce)
  }
  for (const nonce of ["", "a".repeat(31), "a".repeat(33), "A".repeat(32), "g".repeat(32),
    "a".repeat(32) + "\n", " a".repeat(16), 123, null, ["a".repeat(32)]]) {
    assert.equal(healthReportSchema.safeParse({ ...report, nonce }).success, false, JSON.stringify(nonce))
  }
})

test("Cloud Shell launch quotes only base64 config and verifies before extracting or executing", () => {
  const command = cloudShellCommand(launch)
  execFileSync("bash", ["-n"], { input: command })
  assert.ok(command.indexOf("sha256sum --check --status") < command.indexOf("python3 -"))
  assert.ok(command.indexOf("OPENWORK_SAFE_EXTRACT\n") < command.indexOf('python3 "$work/infra/managed-deployments/gcp/runner/install.py"'))
  assert.ok(!command.includes("tar -xzf"))
  assert.ok(!command.includes("--location"))
  const encoded = /--config-base64 '([A-Za-z0-9+/=]+)'/.exec(command)?.[1]
  assert.ok(encoded)
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64").toString()), launch)
  assert.ok(!command.includes(launch.ownerEmail))
  assert.throws(() => cloudShellCommand({ ...launch, release: { ...launch.release, bundleSha256: "$(echo injected)" } }))
  assert.throws(() => cloudShellCommand({ ...launch, release: { ...launch.release, bundleUrl: "http://releases.example.com/bundle.tar.gz" } }))
})

test("GCP bundle coordinates pin exactly one immutable GCS generation", () => {
  assert.equal(gcpBundleUrlSchema.safeParse(launch.release.bundleUrl).success, true)
  for (const url of [
    "https://storage.googleapis.com/openwork-test/bundle.tar.gz",
    "https://storage.googleapis.com/openwork-test/bundle.tar.gz?generation=0",
    "https://storage.googleapis.com/openwork-test/bundle.tar.gz?generation=123&generation=456",
    "https://storage.googleapis.com/openwork-test/bundle.tar.gz?generation=123&other=456",
    "https://attacker.example.com/openwork-test/bundle.tar.gz?generation=123",
    "https://name:password@storage.googleapis.com/openwork-test/bundle.tar.gz?generation=123",
    "not a URL", "", "https://[invalid", "https://", "/relative/path",
  ]) assert.equal(gcpBundleUrlSchema.safeParse(url).success, false)
})

// Cloud Shell has GNU sha256sum; macOS's /sbin/sha256sum does not accept
// its long options. Keep the real digest check in this cross-platform harness.
function installChecksumTool(bin: string) {
  writeFileSync(join(bin, "sha256sum"), `#!${process.execPath}\nconst assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
assert.deepEqual(process.argv.slice(2), ["--check", "--status"]);
const match = /^([a-f0-9]{64})  (.+)\\n$/.exec(fs.readFileSync(0, "utf8"));
if (!match) process.exit(1);
process.exit(crypto.createHash("sha256").update(fs.readFileSync(match[2])).digest("hex") === match[1] ? 0 : 1);
`, { mode: 0o700 })
}

type ArchiveMutation = { name?: string; type?: string; link?: string; manifest?: string; sharedModule?: boolean; extraFile?: string; omittedModuleFile?: string }
const fixtureArchive = String.raw`
import hashlib, io, json, sys, tarfile
mutation = json.loads(sys.argv[2])
installer = b'''import base64, json, os, sys\nfrom pathlib import Path\nconfig = json.loads(base64.b64decode(sys.argv[2], validate=True))\nPath(os.environ["TEST_EXECUTED"]).write_text(json.dumps({"config": config, "installer": __file__}))\n'''
files = {"infra/managed-deployments/gcp/" + name: data for name, data in {
    "runner/install.py": installer, "runner/runner.py": b"# runner\n",
    "health/health_agent.py": b"# health\n", "terraform/main.tf": b"# terraform\n",
    "terraform/.terraform.lock.hcl": b"# lock\n"}.items()}
module = "infra/terraform/modules/openwork-gcp-cloud-run/"
if mutation.get("sharedModule"):
    files.update({module + name: b"# shared fixture\\n" for name in ("main.tf", "cloudrun.tf", "database.tf", "lb.tf", "variables.tf", "versions.tf", "outputs.tf")})
if mutation.get("extraFile"):
    files[mutation["extraFile"]] = b"# not allowed\\n"
if mutation.get("omittedModuleFile"):
    files.pop(module + mutation["omittedModuleFile"])
manifest = {"provider": "gcp", "version": "1.0.0", "protocolVersion": 1,
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
if mutation.get("manifest") == "hash":
    manifest["files"]["infra/managed-deployments/gcp/runner/install.py"] = "0" * 64
if mutation.get("manifest") == "version":
    manifest["version"] = "2.0.0"
if mutation.get("manifest") == "inventory":
    manifest["files"].pop("infra/managed-deployments/gcp/runner/install.py")
files["release.json"] = json.dumps(manifest).encode()
with tarfile.open(sys.argv[1], "w:gz", format=tarfile.PAX_FORMAT) as archive:
    for name, data in files.items():
        member = tarfile.TarInfo(name)
        member.size = len(data)
        archive.addfile(member, io.BytesIO(data))
    if "name" in mutation:
        member = tarfile.TarInfo(mutation["name"])
        member.type = {"symlink": tarfile.SYMTYPE, "hardlink": tarfile.LNKTYPE,
                       "fifo": tarfile.FIFOTYPE, "character": tarfile.CHRTYPE,
                       "block": tarfile.BLKTYPE, "directory": tarfile.DIRTYPE}.get(mutation.get("type"), tarfile.REGTYPE)
        member.linkname = mutation.get("link", "../../outside")
        archive.addfile(member)
`

function withCommandFixture(mutation: ArchiveMutation, run: (command: string, env: NodeJS.ProcessEnv, marker: string, fixture: GcpLaunch) => void) {
  const dir = mkdtempSync(join(tmpdir(), "openwork-gcp-archive-"))
  try {
    const archive = join(dir, "bundle.tar.gz")
    execFileSync("python3", ["-c", fixtureArchive, archive, JSON.stringify(mutation)])
    const fixture = { ...launch, release: { ...launch.release, bundleSha256: createHash("sha256").update(readFileSync(archive)).digest("hex") } }
    const bin = join(dir, "bin")
    const marker = join(dir, "executed.json")
    mkdirSync(bin)
    installChecksumTool(bin)
    writeFileSync(join(bin, "curl"), '#!/bin/bash\nwhile [ "$1" != "--output" ]; do shift; done\ncp -- "$TEST_BUNDLE" "$2"\n', { mode: 0o700 })
    run(cloudShellCommand(fixture), { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_BUNDLE: archive, TEST_EXECUTED: marker }, marker, fixture)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test("valid checked Cloud Shell bundle executes the actual packaged installer path with intact config", () => {
  withCommandFixture({}, (command, env, marker, fixture) => {
    execFileSync("bash", ["-c", command], { env, stdio: "pipe" })
    const executed = JSON.parse(readFileSync(marker, "utf8"))
    assert.deepEqual(executed.config, fixture)
    assert.ok(executed.installer.endsWith("/infra/managed-deployments/gcp/runner/install.py"))
    assert.throws(() => readFileSync(executed.installer), "temporary bundle is cleaned up after successful execution")
  })
})

test("Den's trusted extraction accepts the real shared-module installer bundle", () => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-gcp-real-bundle-"))
  try {
    const bin = join(dir, "bin")
    mkdirSync(bin)
    // Registry metadata alone is mocked. The production builder packages the
    // real source bytes, and the unmodified Den-generated extractor checks them.
    writeFileSync(join(bin, "docker"), `#!${process.execPath}
const ref = process.argv.at(-1);
const digest = "sha256:" + (ref.includes("openwork-den-api") ? "a" : ref.includes("openwork-den-web") ? "b" : "c").repeat(64);
console.log(JSON.stringify({ Descriptor: { digest, platform: { os: "linux", architecture: "amd64" } }, SchemaV2Manifest: { config: { digest: "sha256:" + "d".repeat(64) } } }));
`, { mode: 0o700 })
    const pins = join(dir, "pins.json")
    writeFileSync(pins, JSON.stringify({ den_api: "ghcr.io/different-ai/openwork-den-api@sha256:" + "a".repeat(64), den_web: "ghcr.io/different-ai/openwork-den-web@sha256:" + "b".repeat(64) }))
    const root = fileURLToPath(new URL("../../../../", import.meta.url))
    execFileSync(process.execPath, [join(root, "infra/managed-deployments/tools/build-release.mjs"), "gcp", "1.0.0", dir, "--image-pins", pins], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe",
    })
    const bundle = join(dir, "bundle.tar.gz")
    const fixture = { ...launch, release: { ...launch.release, bundleSha256: createHash("sha256").update(readFileSync(bundle)).digest("hex") } }
    const command = cloudShellCommand(fixture)
    const extraction = /<<'OPENWORK_SAFE_EXTRACT'\n([\s\S]*?)\nOPENWORK_SAFE_EXTRACT\n/.exec(command)?.[1]
    assert.ok(extraction)
    const destination = join(dir, "extracted")
    execFileSync("python3", ["-c", extraction, bundle, destination, fixture.release.version], { stdio: "pipe" })
    const module = "infra/terraform/modules/openwork-gcp-cloud-run"
    for (const name of ["main.tf", "cloudrun.tf", "database.tf", "lb.tf", "variables.tf", "versions.tf", "outputs.tf"]) {
      assert.deepEqual(readFileSync(join(destination, module, name)), readFileSync(join(root, module, name)))
    }
    assert.deepEqual(readFileSync(join(destination, "infra/managed-deployments/gcp/terraform/moved.tf")), readFileSync(join(root, "infra/managed-deployments/gcp/terraform/moved.tf")))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("trusted extraction refuses other modules, nested executables and incomplete shared modules", () => {
  for (const mutation of [
    { sharedModule: true, extraFile: "infra/terraform/modules/openwork-aws-ecs/main.tf" },
    { sharedModule: true, extraFile: "infra/terraform/modules/openwork-gcp-cloud-run-evil/main.tf" },
    { sharedModule: true, extraFile: "infra/terraform/modules/openwork-gcp-cloud-run/tests/main.tf" },
    { sharedModule: true, extraFile: "infra/terraform/modules/openwork-gcp-cloud-run/execute.py" },
    { sharedModule: true, omittedModuleFile: "database.tf" },
  ]) {
    withCommandFixture(mutation, (command, env, marker) => {
      assert.throws(() => execFileSync("bash", ["-c", command], { env, stdio: "pipe" }), /unexpected executable|incomplete shared GCP module/)
      assert.throws(() => readFileSync(marker))
    })
  }
})

test("digest-matching malicious archives fail before executing their installer", () => {
  for (const mutation of [
    { name: "/outside" }, { name: "../outside" }, { name: "infra/../../outside" },
    { name: "infra\\outside" }, { name: "infra/./outside" }, { name: "infra//outside" },
    { name: "infra/link", type: "symlink" }, { name: "infra/link", type: "hardlink" },
    { name: "infra/device", type: "character" }, { name: "infra/device", type: "block" },
    { name: "infra/pipe", type: "fifo" },
    { name: "release.json" }, { name: "infra/managed-deployments/gcp/runner/install.py" },
    { name: "infra/managed-deployments/gcp/runner/install.py/", type: "directory" },
    { manifest: "hash" }, { manifest: "version" }, { manifest: "inventory" },
  ]) {
    withCommandFixture(mutation, (command, env, marker) => {
      const expected = mutation.manifest === "hash" ? /release file checksum mismatch/
        : mutation.manifest === "version" ? /wrong release manifest/
          : mutation.manifest === "inventory" ? /release file inventory mismatch/ : /unsafe bundle archive/
      assert.throws(() => execFileSync("bash", ["-c", command], { env, stdio: "pipe" }), expected, JSON.stringify(mutation))
      assert.throws(() => readFileSync(marker), JSON.stringify(mutation))
    })
  }
})

test("checksum mismatch stops Cloud Shell before extraction or Python execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "openwork-gcp-command-"))
  try {
    const bin = join(dir, "bin")
    mkdirSync(bin)
    installChecksumTool(bin)
    writeFileSync(join(bin, "curl"), '#!/bin/bash\nwhile [ "$1" != "--output" ]; do shift; done\nprintf tampered > "$2"\n', { mode: 0o700 })
    for (const executable of ["python3", "tar"]) writeFileSync(join(bin, executable), `#!/bin/bash\nprintf executed >> '${join(dir, "executed")}'\n`, { mode: 0o700 })
    assert.throws(() => execFileSync("bash", ["-c", cloudShellCommand(launch)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" }))
    assert.throws(() => readFileSync(join(dir, "executed")))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
