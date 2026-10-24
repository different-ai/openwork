import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"
import { gcpTargetSchema, versionSchema, type GcpTarget } from "@openwork/managed-deployments/schema"

const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), { timeoutDuration: 10_000 })
export const gcpBundleUrlSchema = z.string().url().refine((value) => {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  const generations = url.searchParams.getAll("generation")
  return url.protocol === "https:" && url.host === "storage.googleapis.com" && !url.username && !url.password && !url.hash
    && /^\/[a-z0-9][a-z0-9._-]{1,221}\/[^\\\s]+$/.test(url.pathname)
    && [...url.searchParams.keys()].every((key) => key === "generation") && generations.length === 1 && /^[1-9][0-9]*$/.test(generations[0])
}, "Use an immutable Google Cloud Storage generation URL.")
export const gcpIdTokenSchema = z.string().min(1).max(16_384)
export const gcpEnrollmentSchema = z.object({ provider: z.literal("gcp"), idToken: gcpIdTokenSchema }).strict()

export function serviceAccountName(deploymentId: string, purpose: "runner" | "health") {
  return `ow-${z.string().uuid().parse(deploymentId).replaceAll("-", "").slice(0, 12)}-${purpose}`
}
export function serviceAccountEmail(deploymentId: string, projectId: string, purpose: "runner" | "health") {
  return `${serviceAccountName(deploymentId, purpose)}@${projectId}.iam.gserviceaccount.com`
}
export function consoleUrl(projectId: string) {
  return `https://console.cloud.google.com/run?project=${encodeURIComponent(projectId)}`
}
export function enrollmentAudience(apiOrigin: string, deploymentId: string, runId: string, challenge: string) {
  return `${new URL(apiOrigin).origin}/v1/managed-deployments/${deploymentId}/runs/${runId}/enroll#${challenge}`
}
export function heartbeatAudience(apiOrigin: string, deploymentId: string, bodySha256: string) {
  return `${new URL(apiOrigin).origin}/v1/managed-deployments/${deploymentId}/heartbeat#${bodySha256}`
}

/** Google verifies the signature; neither token key URLs nor request headers choose a trust root. */
export async function verifyGcpIdentity(input: {
  idToken: string
  audience: string
  email: string
  now?: Date
  // Local key resolver for isolated cryptographic tests. Routes always use the fixed Google JWKS.
  keyResolver?: Parameters<typeof jwtVerify>[1]
}) {
  const now = input.now ?? new Date()
  const { payload } = await jwtVerify(gcpIdTokenSchema.parse(input.idToken), input.keyResolver ?? googleKeys, {
    algorithms: ["RS256"], issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: input.audience, requiredClaims: ["iat", "exp", "sub", "email", "email_verified"],
    currentDate: now, clockTolerance: 0, maxTokenAge: "60s",
  })
  if (payload.aud !== input.audience || payload.email !== input.email || payload.email_verified !== true || typeof payload.sub !== "string" || !payload.sub
    || typeof payload.iat !== "number" || typeof payload.exp !== "number"
    || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.iat * 1000 > now.getTime()
    || payload.exp <= payload.iat || payload.exp - payload.iat > 3600) throw new Error("identity_invalid")
  return new Date(payload.iat * 1000)
}

export type GcpLaunch = {
  deploymentId: string
  runId: string
  challenge: string
  target: GcpTarget
  domainName: string
  ownerEmail: string
  size: string
  release: { templateUrl: string; bundleUrl: string; bundleSha256: string; version: string; apiOrigin: string }
}
function quoteShell(value: string) { return `'${value.replaceAll("'", `'\\''`)}'` }

// This bootstrap is trusted command text, not code loaded from the archive.
// Validate the entire archive and its inventory before writing any member.
const safeExtraction = String.raw`import hashlib, json, sys, tarfile
from pathlib import Path
archive, destination, version = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
if archive.stat().st_size > 32 * 1024 * 1024:
    raise ValueError("bundle size limit")
with tarfile.open(archive, "r:gz") as tar:
    members, seen, total = [], set(), 0
    for member in tar:
        path = Path(member.name)
        canonical = path.as_posix()
        if (path.is_absolute() or ".." in path.parts or "\\" in member.name
                or canonical in (".", "") or canonical != member.name.rstrip("/")
                or canonical in seen or not (member.isdir() or member.isfile())
                or member.size < 0 or (member.isdir() and member.size != 0)
                or (member.name.endswith("/") and not member.isdir())
                or not (canonical == "release.json" or canonical == "infra" and member.isdir() or canonical.startswith("infra/"))):
            raise ValueError("unsafe bundle archive")
        seen.add(canonical)
        total += member.size
        if total > 64 * 1024 * 1024 or len(seen) > 2000:
            raise ValueError("bundle expansion limit")
        members.append(member)
    regular = {m.name: m for m in members if m.isfile()}
    if any(parent.as_posix() in regular for member in members for parent in Path(member.name).parents):
        raise ValueError("file used as archive directory")
    if "release.json" not in regular or regular["release.json"].size > 1024 * 1024:
        raise ValueError("missing or oversized release manifest")
    with tar.extractfile(regular["release.json"]) as source:
        manifest = json.load(source)
    if manifest.get("provider") != "gcp" or manifest.get("version") != version or manifest.get("protocolVersion") != 1:
        raise ValueError("wrong release manifest")
    files = manifest.get("files")
    if not isinstance(files, dict) or set(files) != set(regular) - {"release.json"}:
        raise ValueError("release file inventory mismatch")
    shared_module = "infra/terraform/modules/openwork-gcp-cloud-run/"
    for name, digest in files.items():
        if (not name.startswith(("infra/managed-deployments/gcp/", "infra/managed-deployments/contract/", shared_module))
                or "/tests/" in name or "/examples/" in name
                or not name.endswith((".py", ".tf", "/.terraform.lock.hcl"))
                or (name.startswith(shared_module) and (len(Path(name).parts) != 5 or not name.endswith(".tf")))):
            raise ValueError("unexpected executable in bundle")
        with tar.extractfile(regular[name]) as source:
            if hashlib.sha256(source.read()).hexdigest() != digest:
                raise ValueError("release file checksum mismatch")
    required = ["runner/install.py", "runner/runner.py", "health/health_agent.py", "terraform/main.tf", "terraform/.terraform.lock.hcl"]
    if any("infra/managed-deployments/gcp/" + name not in files for name in required):
        raise ValueError("incomplete release bundle")
    # Keep accepting published legacy bundles with no shared module. Once a
    # module is present, require its complete operational file set.
    if any(name.startswith(shared_module) for name in files):
        required_module = ("main.tf", "cloudrun.tf", "database.tf", "lb.tf", "variables.tf", "versions.tf", "outputs.tf")
        if any(shared_module + name not in files for name in required_module):
            raise ValueError("incomplete shared GCP module")
    destination.mkdir(mode=0o700, exist_ok=True)
    for member in members:
        target = destination / member.name
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(member) as source, target.open("xb") as output:
                output.write(source.read())
            target.chmod(0o600)`

/** Executes no downloaded code until the pinned archive's digest has been verified. */
export function cloudShellCommand(input: GcpLaunch) {
  gcpTargetSchema.parse(input.target)
  z.string().uuid().parse(input.deploymentId)
  z.string().uuid().parse(input.runId)
  z.string().regex(/^[a-f0-9]{64}$/).parse(input.challenge)
  z.string().regex(/^[a-f0-9]{64}$/).parse(input.release.bundleSha256)
  versionSchema.parse(input.release.version)
  gcpBundleUrlSchema.parse(input.release.bundleUrl)
  const config = Buffer.from(JSON.stringify(input)).toString("base64")
  return [
    "(",
    "set -eu",
    "work=$(mktemp -d)",
    'trap \'rm -rf -- "$work"\' EXIT',
    `curl --fail --silent --show-error --proto '=https' --max-filesize 33554432 --connect-timeout 10 --max-time 120 --output "$work/bundle.tar.gz" ${quoteShell(input.release.bundleUrl)}`,
    `printf '%s  %s\\n' ${quoteShell(input.release.bundleSha256)} "$work/bundle.tar.gz" | sha256sum --check --status`,
    `python3 - "$work/bundle.tar.gz" "$work" ${quoteShell(input.release.version)} <<'OPENWORK_SAFE_EXTRACT'`,
    safeExtraction,
    "OPENWORK_SAFE_EXTRACT",
    `python3 "$work/infra/managed-deployments/gcp/runner/install.py" --config-base64 ${quoteShell(config)}`,
    ")",
  ].join("\n")
}
