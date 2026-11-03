import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const source = await readFile(new URL("../../../apps/den-worker-runtime/scripts/cloud-desktop.sh", import.meta.url), "utf8")
const functions = source.slice(source.indexOf("guard_desktop_nft() {"), source.indexOf("\ncommand -v iptables"))

test("native desktop filtering covers both address families and every isolated account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-network-"))
  try {
    const rules = join(directory, "rules")
    const result = spawnSync("sh", ["-eu", "-c", `
      id() { case "$*" in '-u openwork-browser') printf 1001;; '-u openwork-app') printf 1002;; '-u openwork-command') printf 1003;; esac; }
      awk() { printf '10.0.0.53\\nfd00::53\\n'; }
      nft() { if [ "$1" = list ]; then return 1; fi; cat > "$RULES"; }
      ${functions}
      guard_desktop_egress
    `], { env: { ...process.env, RULES: rules }, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    const configured = await readFile(rules, "utf8")
    assert.match(configured, /meta skuid 1002 reject/)
    assert.match(configured, /meta skuid 1003 tcp dport \{ 5900-5903, 6080, 9222 \} reject/)
    assert.match(configured, /meta skuid 1001 ip daddr .*127\.0\.0\.0\/8.*169\.254\.0\.0\/16.*reject/)
    assert.match(configured, /meta skuid 1001 ip6 daddr .*::ffff:0:0\/96.*fc00::\/7.*reject/)
    assert.match(configured, /ip daddr 10\.0\.0\.53 meta l4proto \{ tcp, udp \} th dport 53 accept/)
    assert.match(configured, /ip6 daddr fd00::53 meta l4proto \{ tcp, udp \} th dport 53 accept/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("an unsupported native firewall stops startup without bypassing isolation", () => {
  const result = spawnSync("sh", ["-eu", "-c", `
    id() { printf 1001; }
    awk() { printf '10.0.0.53\\n'; }
    nft() { return 3; }
    iptables() { printf 'unexpected fallback'; }
    ${functions}
    guard_desktop_egress
    printf 'unexpected startup'
  `], { encoding: "utf8" })
  assert.equal(result.status, 3)
  assert.doesNotMatch(result.stdout, /unexpected/)
})
