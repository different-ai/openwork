import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { runInNewContext } from "node:vm"

// Exercise the actual served shell script, including template-string escaping.
const route = readFileSync(new URL("../../../ee/apps/landing/app/install.sh/route.ts", import.meta.url), "utf8")
const script = runInNewContext(route.match(/const installScript = (`[\s\S]*?`);/)[1])
const fixture = fileURLToPath(new URL("./fixtures/node-version.mjs", import.meta.url))
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const installerTest = process.platform === "win32" ? test.skip : test

function install(systemVersion, { privateVersion = "24.22.1", badChecksum = false, override = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "installer-node-test-"))
  try {
    const shims = join(dir, "shims")
    const tree = join(dir, "tree")
    mkdirSync(shims)
    mkdirSync(join(tree, "node/bin"), { recursive: true })
    const wrapper = (version) => `#!/bin/sh\nTEST_NODE_VERSION=${quote(version)}; export TEST_NODE_VERSION\nexec ${quote(process.execPath)} --import ${quote(fixture)} "$@"\n`
    const executable = (path, content) => { writeFileSync(path, content); chmodSync(path, 0o755) }
    executable(join(shims, "node"), systemVersion === null ? "#!/bin/sh\nexit 127\n" : wrapper(systemVersion))
    executable(join(tree, "node/bin/node"), wrapper(privateVersion))
    const os = process.platform === "darwin" ? "darwin" : "linux"
    const tarball = `node-v24.22.1-${os}-${process.arch}.tar.gz`
    const archive = join(dir, tarball)
    const packed = spawnSync("tar", ["-czf", archive, "-C", tree, "node"], { encoding: "utf8" })
    assert.ifError(packed.error)
    assert.equal(packed.status, 0, packed.stderr)
    const sha = badChecksum ? "0".repeat(64) : createHash("sha256").update(readFileSync(archive)).digest("hex")
    const sums = join(dir, "sums")
    // Include a newer major first to ensure the installer selects the pinned build.
    writeFileSync(sums, `${"1".repeat(64)}  node-v26.0.0-${os}-${process.arch}.tar.gz\n${sha}  ${tarball}\n`)
    const cli = join(dir, "cli.mjs")
    writeFileSync(cli, 'console.log("CLI_INSTALLED");')
    const trace = join(dir, "requests")
    const dist = override ? "https://mirror.test/node/v24.22.1" : "https://nodejs.org/dist/v24.22.1"
    executable(join(shims, "curl"), `#!/bin/sh
for url do :; done
printf '%s\\n' "$url" >> ${quote(trace)}
case "$url" in
  ${quote(`${dist}/SHASUMS256.txt`)}) cat ${quote(sums)} ;;
  ${quote(`${dist}/${tarball}`)}) cat ${quote(archive)} ;;
  'https://openworklabs.com/openwork-bootstrap.mjs') cat ${quote(cli)} ;;
  *) echo "Unexpected download: $url" >&2; exit 1 ;;
esac
`)
    const installer = join(dir, "install.sh")
    writeFileSync(installer, script)
    const result = spawnSync("sh", [installer], {
      encoding: "utf8", timeout: 10_000,
      env: {
        ...process.env, PATH: `${shims}:${process.env.PATH}`, HOME: dir,
        OPENWORK_BIN_DIR: join(dir, "bin"), OPENWORK_INSTALL_DIR: join(dir, "install"),
        OPENWORK_BOOTSTRAP_CLI_URL: "https://openworklabs.com/openwork-bootstrap.mjs",
        OPENWORK_NODE_DIST_URL: override ? dist : "",
      },
    })
    assert.ifError(result.error)
    return { ...result, requests: readFileSync(trace, "utf8").trim().split("\n"), dist, tarball }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const version of ["24.22.1", "24.22.2", "24.23.0"]) installerTest(`installer reuses supported system Node ${version}`, () => {
  const result = install(version)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CLI_INSTALLED/)
  assert.deepEqual(result.requests, ["https://openworklabs.com/openwork-bootstrap.mjs"])
})
for (const version of [null, "20.20.0", "22.13.0", "23.4.0", "24.18.0", "24.21.99", "24.22.0", "25.0.0", "26.0.0", "24.22.1-rc.1", "garbage"]) installerTest(`installer replaces unsupported system Node ${version}`, () => {
  const result = install(version)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /CLI_INSTALLED/)
  assert.deepEqual(result.requests, [`${result.dist}/SHASUMS256.txt`, `${result.dist}/${result.tarball}`, "https://openworklabs.com/openwork-bootstrap.mjs"])
})
installerTest("installer preserves the distribution mirror override and pinned filename", () => {
  const result = install("24.22.0", { override: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.requests[0], "https://mirror.test/node/v24.22.1/SHASUMS256.txt")
})
installerTest("installer aborts a checksum mismatch before extracting or running the CLI", () => {
  const result = install("24.22.0", { badChecksum: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /checksum mismatch/)
  assert.doesNotMatch(result.stdout, /CLI_INSTALLED/)
  assert.equal(result.requests.length, 2)
})
installerTest("installer checks the downloaded runtime too, before downloading the CLI", () => {
  const result = install("24.22.0", { privateVersion: "26.0.0" })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Downloaded runtime is not a supported Node.js 24.x/)
  assert.doesNotMatch(result.stdout, /CLI_INSTALLED/)
  assert.equal(result.requests.length, 2)
})
