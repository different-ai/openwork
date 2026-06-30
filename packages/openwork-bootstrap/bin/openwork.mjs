#!/usr/bin/env node
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const VERSION = "0.1.0"
// The installed command name. Deliberately NOT "openwork" so it never collides
// with the openwork-orchestrator npm package, which also installs an "openwork"
// binary onto the user's PATH.
const COMMAND_NAME = "openwork-bootstrap"
const executableBasename = () => (process.platform === "win32" ? `${COMMAND_NAME}.cmd` : COMMAND_NAME)
const here = dirname(fileURLToPath(import.meta.url))
const selfPath = fileURLToPath(import.meta.url)

function parseArgs(argv) {
  const positionals = []
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith("--")) {
      positionals.push(arg)
      continue
    }

    const raw = arg.slice(2)
    const eq = raw.indexOf("=")
    if (eq >= 0) {
      flags.set(raw.slice(0, eq), raw.slice(eq + 1))
      continue
    }

    const next = argv[index + 1]
    if (next && !next.startsWith("--")) {
      flags.set(raw, next)
      index += 1
    } else {
      flags.set(raw, true)
    }
  }
  return { positionals, flags }
}

function getFlag(flags, name, fallback = undefined) {
  const value = flags.get(name)
  return value === undefined || value === true ? fallback : String(value)
}

function hasFlag(flags, name) {
  return flags.get(name) === true || flags.get(name) === "true"
}

function jsonOut(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2))
  } else if (value.message) {
    console.log(value.message)
  } else {
    console.log(JSON.stringify(value, null, 2))
  }
}

function printHelp() {
  console.log([
    "openwork-bootstrap",
    "",
    "Usage:",
    "  openwork-bootstrap install [--bin-dir <path>] [--install-dir <path>] [--source <path>] [--json]",
    "  openwork-bootstrap install app --manifest <url-or-file> [--app-dir <path>] [--json]",
    "  openwork-bootstrap doctor [--bin-dir <path>] [--install-dir <path>] [--base-url <url>] [--desktop-bootstrap] [--json]",
    "  OPENWORK_OWNER_PASSWORD=<password> openwork-bootstrap cloud onboard --base-url <url> --owner-email <email> --org-name <name> --invite-email <email> [--skill-name <name>] [--prepare-desktop] [--json]",
    "  openwork-bootstrap cloud bootstrap-workspace --base-url <url> --workspace-name <name> [--skill-name <name>] [--teammate-emails a@x.com,b@y.com] [--claim-roles owner,member] [--prepare-desktop] [--json]",
    "  openwork-bootstrap cloud claim-link [--role owner] [--desktop-bootstrap-path <path>] [--json]",
    "",
    "Commands:",
    "  install          Install the openwork-bootstrap CLI into a user bin dir",
    "  install app      Download and install the desktop app from a manifest",
    "  doctor           Check CLI installation and optional Den API health",
    "  cloud onboard    Sign up, create an org, invite a teammate, and create a skill",
    "  cloud bootstrap-workspace  Create a provisional workspace without email/password auth",
    "  cloud claim-link Retrieve a claim link saved by --prepare-desktop. Only run",
    "                   this when you are ready to hand the link to a human; do",
    "                   not print claim links preemptively.",
    "",
    "Options:",
    "  --json           Print machine-readable JSON",
    "  --version        Print version",
    "  --help           Show help",
  ].join("\n"))
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

function defaultInstallDir() {
  return process.env.OPENWORK_INSTALL_DIR || join(process.env.HOME || process.cwd(), ".openwork", "bootstrap")
}

function defaultBinDir() {
  return process.env.OPENWORK_BIN_DIR || join(process.env.HOME || process.cwd(), ".local", "bin")
}

function defaultAppDir() {
  return process.env.OPENWORK_APP_DIR || (process.platform === "darwin"
    ? join(process.env.HOME || process.cwd(), "Applications")
    : process.platform === "win32"
      ? join(process.env.LOCALAPPDATA || join(process.env.HOME || process.cwd(), "AppData", "Local"), "OpenWork")
      : join(process.env.HOME || process.cwd(), ".local", "share", "openwork"))
}

function configHomeDir() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA
  return join(process.env.HOME || process.cwd(), ".config")
}

function defaultDesktopBootstrapPath() {
  return process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH || join(configHomeDir(), "openwork", "desktop-bootstrap.json")
}

function defaultSkillsDir() {
  return process.env.OPENWORK_SKILLS_DIR || join(configHomeDir(), "opencode", "skills")
}

function defaultDeviceKeyPath() {
  return process.env.OPENWORK_DEVICE_KEY_PATH || join(configHomeDir(), "openwork", "bootstrap-device-key.json")
}

function slugifySkillName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "openwork-bootstrap-skill"
}

function runInstall(args) {
  if (args.positionals[1] === "app") {
    return runInstallApp(args)
  }

  const installDir = resolve(getFlag(args.flags, "install-dir", defaultInstallDir()))
  const binDir = resolve(getFlag(args.flags, "bin-dir", defaultBinDir()))
  const source = resolve(getFlag(args.flags, "source", selfPath))
  const json = hasFlag(args.flags, "json")

  if (!existsSync(source)) {
    throw new Error(`source_not_found: ${source}`)
  }

  mkdirSync(installDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })

  const installedCli = join(installDir, "openwork.mjs")
  copyFileSync(source, installedCli)
  chmodSync(installedCli, 0o755)

  const executable = join(binDir, executableBasename())
  if (process.platform === "win32") {
    writeFileSync(executable, `@echo off\r\nnode "${installedCli}" %*\r\n`)
  } else {
    writeFileSync(executable, `#!/usr/bin/env sh\nexec node "${installedCli}" "$@"\n`)
  }
  chmodSync(executable, 0o755)

  const manifest = {
    version: VERSION,
    installedAt: new Date().toISOString(),
    installDir,
    binDir,
    executable,
    cli: installedCli,
  }
  writeFileSync(join(installDir, "install.json"), JSON.stringify(manifest, null, 2))

  jsonOut({ ok: true, message: `OpenWork CLI installed at ${executable}`, install: manifest }, json)
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

function filePathFromUrl(value) {
  if (value.startsWith("file://")) {
    return fileURLToPath(value)
  }
  return resolve(value)
}

async function readJsonLocation(location) {
  if (isHttpUrl(location)) {
    const response = await fetch(location)
    if (!response.ok) throw new Error(`manifest_fetch_failed: ${response.status}`)
    return response.json()
  }
  return JSON.parse(readFileSync(filePathFromUrl(location), "utf8"))
}

async function downloadArtifact(url, destination) {
  if (isHttpUrl(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`artifact_download_failed: ${response.status}`)
    writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
    return
  }
  copyFileSync(filePathFromUrl(url), destination)
}

function selectArtifact(manifest) {
  const platform = process.platform
  const arch = process.arch
  const candidates = [
    manifest.artifacts?.[platform]?.[arch],
    manifest.artifacts?.[`${platform}-${arch}`],
    manifest.artifacts?.[platform],
    Array.isArray(manifest.artifacts) ? manifest.artifacts.find((artifact) => artifact.platform === platform && (!artifact.arch || artifact.arch === arch)) : null,
  ].filter(Boolean)
  const artifact = candidates[0]
  if (!artifact?.url) throw new Error(`no_artifact_for_platform: ${platform}-${arch}`)
  return { ...artifact, platform, arch }
}

function inferArtifactType(url) {
  const lower = url.toLowerCase()
  if (lower.endsWith(".dmg")) return "dmg"
  if (lower.endsWith(".zip")) return "zip"
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz"
  if (lower.endsWith(".appimage")) return "appimage"
  if (lower.endsWith(".exe")) return "exe"
  if (lower.endsWith(".msi")) return "msi"
  return null
}

function defaultInstalledName(type, manifest, artifact) {
  if (artifact.appName || manifest.appName) return artifact.appName || manifest.appName
  if (type === "dmg") return "OpenWork.app"
  if (type === "appimage") return "OpenWork.AppImage"
  if (type === "exe") return "OpenWork.exe"
  if (type === "msi") return "OpenWork.msi"
  if (process.platform === "darwin") return "OpenWork.app"
  if (process.platform === "win32") return "OpenWork.exe"
  return "openwork"
}

function findInstallCandidate(root, expectedName) {
  const direct = join(root, expectedName)
  if (existsSync(direct)) return direct

  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.name === expectedName) return path
      if (entry.isDirectory()) queue.push(path)
    }
  }
  throw new Error(`app_not_found_in_archive: ${expectedName}`)
}

// Copy an installed artifact into place. macOS .app bundles contain internal
// framework symlinks (e.g. Versions/Current, the framework binary/Resources
// links) that a naive recursive copy can break — leaving dangling links into a
// now-unmounted DMG, which makes Gatekeeper report the app as "damaged". Use
// `ditto` on macOS, which is the Apple-supported way to copy bundles while
// preserving relative symlinks and the code signature.
function copyArtifact(source, target) {
  if (process.platform === "darwin") {
    try {
      execFileSync("ditto", [source, target], { stdio: "pipe" })
    } catch {
      // Fall back to cp -R (also preserves bundle symlinks) before giving up.
      execFileSync("cp", ["-R", source, target], { stdio: "pipe" })
    }
    // Remove the quarantine flag so Gatekeeper does not block the freshly
    // installed (already-notarized) app on first launch. Best-effort.
    try {
      execFileSync("xattr", ["-dr", "com.apple.quarantine", target], { stdio: "pipe" })
    } catch {}
    return
  }
  cpSync(source, target, { recursive: true })
}

function installFromDirectory(input) {
  const source = findInstallCandidate(input.sourceDir, input.appName)
  mkdirSync(input.appDir, { recursive: true })
  const target = join(input.appDir, input.appName)
  rmSync(target, { recursive: true, force: true })
  copyArtifact(source, target)
  if (input.executable) chmodSync(target, 0o755)
  return target
}

function installDmg(input) {
  if (process.platform !== "darwin") {
    throw new Error("dmg_install_requires_macos")
  }

  const mountPoint = join(input.workDir, "mount")
  mkdirSync(mountPoint, { recursive: true })
  let mounted = false
  try {
    execFileSync("hdiutil", ["attach", input.artifactPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint], { stdio: "pipe" })
    mounted = true
    const appName = input.appName || "OpenWork.app"
    const sourceApp = join(mountPoint, appName)
    if (!existsSync(sourceApp)) {
      throw new Error(`app_not_found_in_dmg: ${appName}`)
    }
    mkdirSync(input.appDir, { recursive: true })
    const targetApp = join(input.appDir, appName)
    rmSync(targetApp, { recursive: true, force: true })
    copyArtifact(sourceApp, targetApp)
    return targetApp
  } finally {
    if (mounted) {
      try {
        execFileSync("hdiutil", ["detach", mountPoint, "-quiet"], { stdio: "pipe" })
      } catch {
        execFileSync("hdiutil", ["detach", mountPoint, "-force", "-quiet"], { stdio: "pipe" })
      }
    }
  }
}

function installZip(input) {
  const extractDir = join(input.workDir, "zip")
  mkdirSync(extractDir, { recursive: true })
  if (process.platform === "win32") {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${JSON.stringify(input.artifactPath)} -DestinationPath ${JSON.stringify(extractDir)} -Force`], { stdio: "pipe" })
  } else if (process.platform === "darwin") {
    execFileSync("ditto", ["-x", "-k", input.artifactPath, extractDir], { stdio: "pipe" })
  } else {
    execFileSync("unzip", ["-q", input.artifactPath, "-d", extractDir], { stdio: "pipe" })
  }
  return installFromDirectory({ ...input, sourceDir: extractDir })
}

function installTarGz(input) {
  const extractDir = join(input.workDir, "tar")
  mkdirSync(extractDir, { recursive: true })
  execFileSync("tar", ["-xzf", input.artifactPath, "-C", extractDir], { stdio: "pipe" })
  return installFromDirectory({ ...input, sourceDir: extractDir })
}

function installSingleFile(input) {
  mkdirSync(input.appDir, { recursive: true })
  const target = join(input.appDir, input.appName)
  rmSync(target, { force: true })
  copyFileSync(input.artifactPath, target)
  if (input.executable) chmodSync(target, 0o755)
  return target
}

async function runInstallApp(args) {
  const json = hasFlag(args.flags, "json")
  const manifestLocation = getFlag(args.flags, "manifest") || process.env.OPENWORK_INSTALL_MANIFEST
  if (!manifestLocation) throw new Error("missing_required_flag: --manifest")

  const appDir = resolve(getFlag(args.flags, "app-dir", defaultAppDir()))
  const workDir = join(tmpdir(), `openwork-app-install-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(workDir, { recursive: true })

  try {
    const manifest = await readJsonLocation(manifestLocation)
    const artifact = selectArtifact(manifest)
    const type = artifact.type || inferArtifactType(artifact.url)
    if (!type) throw new Error("unsupported_app_artifact_type: unknown")

    const artifactPath = join(workDir, artifact.fileName || "OpenWork.dmg")
    await downloadArtifact(artifact.url, artifactPath)
    const digest = sha256(readFileSync(artifactPath))
    if (artifact.sha256 && digest !== artifact.sha256) {
      throw new Error(`checksum_mismatch: expected ${artifact.sha256} got ${digest}`)
    }

    const appName = defaultInstalledName(type, manifest, artifact)
    const appPath = type === "dmg"
      ? installDmg({ artifactPath, workDir, appDir, appName })
      : type === "zip"
        ? installZip({ artifactPath, workDir, appDir, appName, executable: !appName.endsWith(".app") && process.platform !== "win32" })
        : type === "tar.gz"
          ? installTarGz({ artifactPath, workDir, appDir, appName, executable: process.platform !== "win32" })
          : type === "appimage"
            ? installSingleFile({ artifactPath, appDir, appName, executable: true })
            : type === "exe" || type === "msi"
              ? installSingleFile({ artifactPath, appDir, appName, executable: false })
              : (() => { throw new Error(`unsupported_app_artifact_type: ${type}`) })()

    const install = {
      version: manifest.version || artifact.version || null,
      installedAt: new Date().toISOString(),
      appDir,
      appPath,
      manifest: manifestLocation,
      artifact: {
        type,
        url: artifact.url,
        sha256: digest,
        platform: artifact.platform,
        arch: artifact.arch,
      },
    }
    mkdirSync(dirname(appPath), { recursive: true })
    writeFileSync(join(appDir, "openwork-app-install.json"), JSON.stringify(install, null, 2))
    jsonOut({ ok: true, message: `OpenWork app installed at ${appPath}`, install }, json)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

async function runDoctor(args) {
  const installDir = resolve(getFlag(args.flags, "install-dir", defaultInstallDir()))
  const binDir = resolve(getFlag(args.flags, "bin-dir", defaultBinDir()))
  const baseUrl = getFlag(args.flags, "base-url")
  const appDir = resolve(getFlag(args.flags, "app-dir", defaultAppDir()))
  const desktopBootstrapPath = resolve(getFlag(args.flags, "desktop-bootstrap-path", defaultDesktopBootstrapPath()))
  const json = hasFlag(args.flags, "json")
  const checks = []

  checks.push({ name: "node", ok: Number(process.versions.node.split(".")[0]) >= 20, value: process.versions.node })
  checks.push({ name: "installDir", ok: existsSync(installDir), value: installDir })
  checks.push({ name: "binDir", ok: existsSync(binDir), value: binDir })

  const executable = join(binDir, executableBasename())
  const executableOk = existsSync(executable) && statSync(executable).isFile()
  checks.push({ name: "openworkExecutable", ok: executableOk, value: executable })

  const manifestPath = join(installDir, "install.json")
  let manifest = null
  if (existsSync(manifestPath)) {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    checks.push({ name: "manifest", ok: true, value: manifestPath })
  } else {
    checks.push({ name: "manifest", ok: false, value: manifestPath })
  }

  if (baseUrl) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`)
      const body = await response.json().catch(() => null)
      checks.push({ name: "denApiHealth", ok: response.ok && body?.ok === true, value: { status: response.status, body } })
    } catch (error) {
      checks.push({ name: "denApiHealth", ok: false, value: error instanceof Error ? error.message : String(error) })
    }
  }

  if (hasFlag(args.flags, "app") || args.flags.has("app-dir")) {
    const appManifest = join(appDir, "openwork-app-install.json")
    let appPath = process.platform === "darwin"
      ? join(appDir, "OpenWork.app")
      : process.platform === "win32"
        ? join(appDir, "OpenWork.exe")
        : join(appDir, "openwork")
    if (existsSync(appManifest)) {
      try {
        const appInstall = JSON.parse(readFileSync(appManifest, "utf8"))
        if (appInstall.appPath) appPath = appInstall.appPath
      } catch {
        // Keep fallback path.
      }
    }
    checks.push({ name: "openworkApp", ok: existsSync(appPath), value: appPath })
    checks.push({ name: "appInstallManifest", ok: existsSync(appManifest), value: appManifest })
  }

  if (hasFlag(args.flags, "desktop-bootstrap") || args.flags.has("desktop-bootstrap-path")) {
    let bootstrap = null
    try {
      bootstrap = JSON.parse(readFileSync(desktopBootstrapPath, "utf8"))
    } catch {
      bootstrap = null
    }
    const handoff = bootstrap?.handoff
    const prepared = bootstrap?.prepared
    checks.push({ name: "desktopBootstrap", ok: Boolean(bootstrap?.baseUrl), value: desktopBootstrapPath })
    checks.push({ name: "desktopBootstrapPrepared", ok: Boolean(prepared?.orgId && prepared?.skillId && prepared?.skillPath), value: prepared ? { orgId: prepared.orgId, orgName: prepared.orgName, skillId: prepared.skillId, skillTitle: prepared.skillTitle, skillPath: prepared.skillPath } : null })
    checks.push({ name: "desktopBootstrapHandoff", ok: Boolean(handoff?.grant && handoff?.orgId && handoff?.skillId) || Boolean(prepared?.orgId && prepared?.skillId), value: handoff ? { orgId: handoff.orgId, orgName: handoff.orgName, skillId: handoff.skillId, skillTitle: handoff.skillTitle } : "consumed" })
  }

  const ok = checks.every((check) => check.ok)
  jsonOut({ ok, message: ok ? "OpenWork doctor: ok" : "OpenWork doctor: failed", version: VERSION, manifest, checks }, json)
  if (!ok) process.exitCode = 1
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: baseUrl,
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: response.status, body }
}

async function signupAndSignin(baseUrl, input) {
  const signup = await request(baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: input.name, email: input.email, password: input.password }),
  })
  if (signup.status !== 200 && signup.status !== 400) {
    throw new Error(`signup_failed: ${signup.status} ${JSON.stringify(signup.body)}`)
  }

  const signin = await request(baseUrl, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: input.email, password: input.password }),
  })
  if (signin.status !== 200 || !signin.body?.token) {
    throw new Error(`signin_failed: ${signin.status} ${JSON.stringify(signin.body)}`)
  }
  return { signup, signin, token: signin.body.token, user: signin.body.user }
}

function skillText(name, output) {
  return `---\nname: ${name}\ndescription: Starter skill created by openwork bootstrap.\nopenworkBootstrapTrigger: bootstrap.verify\nopenworkBootstrapOutput: ${JSON.stringify(output)}\n---\n\n# ${name}\n\nWhen triggered with \`bootstrap.verify\`, output exactly:\n\n\`${output}\`\n\nUse this skill to confirm OpenWork cloud onboarding can create and trigger a deterministic skill.`
}

function readFrontmatterValue(text, key) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null
  for (const line of match[1].split(/\r?\n/g)) {
    const index = line.indexOf(":")
    if (index < 0) continue
    const name = line.slice(0, index).trim()
    if (name !== key) continue
    const raw = line.slice(index + 1).trim()
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      try {
        return JSON.parse(raw)
      } catch {
        return raw.slice(1, -1)
      }
    }
    return raw
  }
  return null
}

function runBootstrapSkill(skill, input) {
  const trigger = readFrontmatterValue(skill.skillText, "openworkBootstrapTrigger")
  const output = readFrontmatterValue(skill.skillText, "openworkBootstrapOutput")
  const triggered = trigger === input.trigger && typeof output === "string" && output.length > 0
  return {
    triggered,
    trigger,
    input,
    output: triggered ? output : null,
    skill: {
      id: skill.id,
      title: skill.title,
    },
  }
}

async function createDesktopHandoff(baseUrl, auth) {
  const handoff = await request(baseUrl, "/v1/auth/desktop-handoff", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ desktopScheme: "openwork" }),
  })
  if (handoff.status !== 200 || !handoff.body?.grant) {
    throw new Error(`desktop_handoff_failed: ${handoff.status} ${JSON.stringify(handoff.body)}`)
  }
  return handoff.body
}

function writePreparedDesktop(input) {
  const bootstrapPath = resolve(input.bootstrapPath)
  const skillName = slugifySkillName(input.skill.title)
  const skillDir = resolve(input.skillsDir, skillName)
  const skillPath = join(skillDir, "SKILL.md")
  mkdirSync(dirname(bootstrapPath), { recursive: true })
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(skillPath, input.skill.skillText, "utf8")
  const preparedAt = new Date().toISOString()
  const prepared = {
    orgId: input.organization.id,
    orgName: input.organization.name,
    orgSlug: input.organization.slug,
    skillId: input.skill.id,
    skillTitle: input.skill.title,
    skillsDir: resolve(input.skillsDir),
    skillPath,
    preparedAt,
  }
  const bootstrap = {
    baseUrl: input.baseUrl,
    apiBaseUrl: input.apiBaseUrl,
    requireSignin: false,
    prepared,
    ...(input.claimLinks ? { claimLinks: input.claimLinks } : {}),
  }
  if (input.handoff) {
    bootstrap.handoff = {
      grant: input.handoff.grant,
      denBaseUrl: input.baseUrl,
      orgId: prepared.orgId,
      orgName: prepared.orgName,
      orgSlug: prepared.orgSlug,
      skillId: prepared.skillId,
      skillTitle: prepared.skillTitle,
      createdAt: preparedAt,
    }
  } else {
    bootstrap.handoff = null
  }

  writeFileSync(bootstrapPath, `${JSON.stringify(bootstrap, null, 2)}\n`, "utf8")

  return {
    prepared: true,
    bootstrapPath,
    skillsDir: resolve(input.skillsDir),
    skillPath,
    ...(input.handoff ? { handoffExpiresAt: input.handoff.expiresAt, handoffGrant: "redacted: saved to bootstrapPath" } : {}),
    ...(input.claimLinks
      ? {
          claimLinks: input.claimLinks.map((link) => ({
            id: link.id,
            role: link.role,
            expiresAt: link.expiresAt,
            url: `redacted: run "openwork-bootstrap cloud claim-link --role ${link.role}" to view`,
          })),
        }
      : {}),
  }
}

function ensureDeviceKey(filePath) {
  const keyPath = resolve(filePath)
  if (existsSync(keyPath)) {
    const stored = JSON.parse(readFileSync(keyPath, "utf8"))
    if (typeof stored.publicKey === "string" && stored.publicKey.trim()) {
      return { path: keyPath, publicKey: stored.publicKey.trim(), reused: true }
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  mkdirSync(dirname(keyPath), { recursive: true })
  writeFileSync(keyPath, `${JSON.stringify({ publicKey, privateKey, createdAt: new Date().toISOString() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  try {
    chmodSync(keyPath, 0o600)
  } catch {}
  return { path: keyPath, publicKey, reused: false }
}

async function resolveOwnerPassword(flags) {
  const fromFlag = getFlag(flags, "owner-password")
  if (fromFlag) return fromFlag

  const envName = getFlag(flags, "owner-password-env", "OPENWORK_OWNER_PASSWORD")
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv

  const filePath = getFlag(flags, "owner-password-file")
  if (filePath) return readFileSync(resolve(filePath), "utf8").trim()

  if (hasFlag(flags, "owner-password-stdin")) return (await readStdin()).trim()

  return null
}

async function runCloudOnboard(args) {
  const subcommand = args.positionals[1]
  if (subcommand !== "onboard") {
    printHelp()
    process.exitCode = 1
    return
  }

  const json = hasFlag(args.flags, "json")
  const baseUrl = getFlag(args.flags, "base-url")?.replace(/\/$/, "")
  const ownerEmail = getFlag(args.flags, "owner-email")
  const ownerPassword = await resolveOwnerPassword(args.flags)
  const orgName = getFlag(args.flags, "org-name")
  const inviteEmail = getFlag(args.flags, "invite-email")
  const skillName = getFlag(args.flags, "skill-name", "First OpenWork Skill")
  const skillOutput = getFlag(args.flags, "skill-output", "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED")
  const prepareDesktop = hasFlag(args.flags, "prepare-desktop")
  const desktopBootstrapPath = getFlag(args.flags, "desktop-bootstrap-path", defaultDesktopBootstrapPath())
  const skillsDir = getFlag(args.flags, "skills-dir", defaultSkillsDir())

  for (const [name, value] of Object.entries({ baseUrl, ownerEmail, ownerPassword, orgName, inviteEmail })) {
    if (!value) throw new Error(`missing_required_flag: --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
  }

  const health = await request(baseUrl, "/health", { method: "GET" })
  if (health.status !== 200 || health.body?.ok !== true) {
    throw new Error(`den_api_unhealthy: ${health.status} ${JSON.stringify(health.body)}`)
  }

  const owner = await signupAndSignin(baseUrl, {
    name: "OpenWork Owner",
    email: ownerEmail,
    password: ownerPassword,
  })
  const auth = { authorization: `Bearer ${owner.token}` }

  const org = await request(baseUrl, "/v1/org", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: orgName }),
  })
  if (org.status !== 201 || !org.body?.organization?.id) {
    throw new Error(`org_create_failed: ${org.status} ${JSON.stringify(org.body)}`)
  }

  const invite = await request(baseUrl, "/v1/invitations", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ email: inviteEmail, role: "member" }),
  })
  if (invite.status !== 201 || !invite.body?.invitationId) {
    throw new Error(`invite_failed: ${invite.status} ${JSON.stringify(invite.body)}`)
  }

  const skill = await request(baseUrl, "/v1/skills", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ skillText: skillText(skillName, skillOutput), shared: "org" }),
  })
  if (skill.status !== 201 || !skill.body?.skill?.id) {
    throw new Error(`skill_create_failed: ${skill.status} ${JSON.stringify(skill.body)}`)
  }

  const skillRun = runBootstrapSkill(skill.body.skill, { trigger: "bootstrap.verify" })
  if (!skillRun.triggered || skillRun.output !== skillOutput) {
    throw new Error(`skill_trigger_failed: ${JSON.stringify(skillRun)}`)
  }

  let desktop = null
  if (prepareDesktop) {
    const handoff = await createDesktopHandoff(baseUrl, auth)
    desktop = writePreparedDesktop({
      baseUrl,
      apiBaseUrl: baseUrl,
      bootstrapPath: desktopBootstrapPath,
      skillsDir,
      handoff,
      organization: org.body.organization,
      skill: skill.body.skill,
    })
  }

  jsonOut({
    ok: true,
    message: "OpenWork cloud onboarding complete",
    user: { id: owner.user.id, email: owner.user.email, emailVerified: owner.user.emailVerified },
    organization: org.body.organization,
    invitation: invite.body,
    skill: skill.body.skill,
    skillRun,
    desktop,
  }, json)
}

async function runCloudBootstrapWorkspace(args) {
  const json = hasFlag(args.flags, "json")
  const baseUrl = getFlag(args.flags, "base-url", "https://api.openworklabs.com")?.replace(/\/$/, "")
  const workspaceName = getFlag(args.flags, "workspace-name")
  const skillName = getFlag(args.flags, "skill-name", "First OpenWork Skill")
  const prepareDesktop = hasFlag(args.flags, "prepare-desktop")
  const desktopBootstrapPath = getFlag(args.flags, "desktop-bootstrap-path", defaultDesktopBootstrapPath())
  const skillsDir = getFlag(args.flags, "skills-dir", defaultSkillsDir())
  const deviceKeyPath = getFlag(args.flags, "device-key-path", defaultDeviceKeyPath())
  const claimRoles = String(getFlag(args.flags, "claim-roles", "owner"))
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean)
  const teammateEmails = String(getFlag(args.flags, "teammate-emails", ""))
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)

  for (const [name, value] of Object.entries({ baseUrl, workspaceName })) {
    if (!value) throw new Error(`missing_required_flag: --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
  }

  const health = await request(baseUrl, "/health", { method: "GET" })
  if (health.status !== 200 || health.body?.ok !== true) {
    throw new Error(`den_api_unhealthy: ${health.status} ${JSON.stringify(health.body)}`)
  }

  const deviceKey = ensureDeviceKey(deviceKeyPath)
  const response = await request(baseUrl, "/v1/bootstrap/workspace", {
    method: "POST",
    body: JSON.stringify({
      workspaceName,
      skillName,
      devicePublicKey: deviceKey.publicKey,
      claimRoles,
      ...(teammateEmails.length > 0 ? { teammateEmails } : {}),
    }),
  })
  if (response.status !== 200 || response.body?.ok !== true || !response.body?.organization?.id || !response.body?.skill?.id) {
    throw new Error(`workspace_bootstrap_failed: ${response.status} ${JSON.stringify(response.body)}`)
  }

  const skill = {
    ...response.body.skill,
    skillText: skillText(response.body.skill.title, response.body.skill.output || "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED"),
  }

  const skillRun = runBootstrapSkill(skill, { trigger: "bootstrap.verify" })
  if (!skillRun.triggered || skillRun.output !== "OPENWORK_BOOTSTRAP_SKILL_TRIGGERED") {
    throw new Error(`skill_trigger_failed: ${JSON.stringify(skillRun)}`)
  }

  let desktop = null
  if (prepareDesktop) {
    desktop = writePreparedDesktop({
      baseUrl,
      apiBaseUrl: baseUrl,
      bootstrapPath: desktopBootstrapPath,
      skillsDir,
      organization: response.body.organization,
      skill,
      claimLinks: response.body.claimLinks,
    })
  }

  jsonOut({
    ok: true,
    message: "OpenWork workspace bootstrap complete",
    organization: response.body.organization,
    setup: response.body.setup,
    skill: response.body.skill,
    skillRun,
    claimLinks: response.body.claimLinks.map((link) => ({
      id: link.id,
      role: link.role,
      expiresAt: link.expiresAt,
      url: prepareDesktop
        ? `redacted: run "openwork-bootstrap cloud claim-link --role ${link.role}" to view`
        : "discarded: rerun with --prepare-desktop to persist this link, otherwise it cannot be retrieved later",
    })),
    device: { publicKeyPath: deviceKey.path, reused: deviceKey.reused },
    desktop,
  }, json)
}

function runCloudClaimLink(args) {
  const json = hasFlag(args.flags, "json")
  const desktopBootstrapPath = resolve(getFlag(args.flags, "desktop-bootstrap-path", defaultDesktopBootstrapPath()))
  const roleFilter = getFlag(args.flags, "role")

  if (!existsSync(desktopBootstrapPath)) {
    throw new Error(`desktop_bootstrap_not_found: ${desktopBootstrapPath} (run cloud bootstrap-workspace --prepare-desktop first)`)
  }

  const bootstrap = JSON.parse(readFileSync(desktopBootstrapPath, "utf8"))
  const allLinks = Array.isArray(bootstrap.claimLinks) ? bootstrap.claimLinks : []
  const claimLinks = roleFilter ? allLinks.filter((link) => link.role === roleFilter) : allLinks

  if (claimLinks.length === 0) {
    throw new Error(
      allLinks.length === 0
        ? `no_claim_links: ${desktopBootstrapPath} has no claim links (this workspace may have been bootstrapped without --prepare-desktop, or claimRoles was empty)`
        : `no_claim_links_for_role: no claim link with role "${roleFilter}" in ${desktopBootstrapPath}`,
    )
  }

  jsonOut({
    ok: true,
    message: "Claim link retrieved. Share this URL only with the person who should own this workspace.",
    bootstrapPath: desktopBootstrapPath,
    claimLinks,
  }, json)
}

async function runCloud(args) {
  const subcommand = args.positionals[1]
  if (subcommand === "claim-link") {
    runCloudClaimLink(args)
    return
  }
  if (subcommand === "onboard") {
    await runCloudOnboard(args)
    return
  }
  if (subcommand === "bootstrap-workspace") {
    await runCloudBootstrapWorkspace(args)
    return
  }
  printHelp()
  process.exitCode = 1
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (hasFlag(args.flags, "help") || args.positionals[0] === "help") {
    printHelp()
    return
  }
  if (hasFlag(args.flags, "version")) {
    console.log(VERSION)
    return
  }

  const command = args.positionals[0] || "help"
  if (command === "install") {
    runInstall(args)
    return
  }
  if (command === "doctor") {
    await runDoctor(args)
    return
  }
  if (command === "cloud") {
    await runCloud(args)
    return
  }

  printHelp()
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
