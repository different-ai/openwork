/** Build the computer image in the operator's Daytona organization; no model or Den credentials enter it. */
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { Daytona, DaytonaNotFoundError } from "@daytonaio/sdk"
import { COMPUTER_INSTALL_SCRIPT, computerSnapshotSlug } from "../src/image.js"

const apiKey = process.env.DAYTONA_API_KEY
if (!apiKey) throw new Error("DAYTONA_API_KEY is required")
const api = new Daytona({ apiKey, apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api", target: process.env.DAYTONA_TARGET })
const name = `${computerSnapshotSlug()}-daytona`
try {
  const existing = await api.snapshot.get(name)
  if (existing.state === "active") {
    console.log(`Snapshot ${name} already exists.`)
    process.exit(0)
  }
  throw new Error(`Snapshot ${name} exists but is ${existing.state}; inspect it before rebuilding.`)
} catch (error) {
  if (!(error instanceof DaytonaNotFoundError)) throw error
}
const directory = await mkdtemp(join(tmpdir(), "openwork-computer-image-"))
try {
  // Ubuntu matches the current Freestyle guest: same username, paths and
  // install script. Only the host mechanics differ (no systemd in the image).
  await writeFile(join(directory, "install.sh"), COMPUTER_INSTALL_SCRIPT)
  await writeFile(join(directory, "Dockerfile"), `FROM ubuntu:24.04\nENV DEBIAN_FRONTEND=noninteractive\nRUN apt-get update -qq && apt-get install -y --no-install-recommends bash sudo python3 python3-pip ca-certificates && (id ubuntu || useradd -m -u 1000 -s /bin/bash ubuntu) && echo 'ubuntu ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/ubuntu\nCOPY install.sh /tmp/install-computer.sh\nRUN bash /tmp/install-computer.sh && rm /tmp/install-computer.sh\nUSER ubuntu\nWORKDIR /workspace\n`)
  // Image builds are provider-native, not running-VM snapshot capture. The
  // CLI's Dockerfile build also avoids the SDK's S3/XML context-upload path.
  await new Promise<void>((resolve, reject) => {
    const child = spawn("daytona", ["snapshot", "create", name, "--dockerfile", join(directory, "Dockerfile"), "--cpu", "2", "--memory", "4", "--disk", "8", "--sandbox-class", "container"], {
      cwd: directory, stdio: "inherit", env: { ...process.env, DAYTONA_API_KEY: apiKey, DAYTONA_API_URL: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api" },
    })
    child.once("error", reject)
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Daytona image build exited ${code}`)))
  })
  console.log(`\nReady: HEADLESS_COMPUTER_SNAPSHOT=${name}`)
} finally { await rm(directory, { recursive: true, force: true }) }
