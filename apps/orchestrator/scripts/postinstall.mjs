#!/usr/bin/env node

import os from "os"
import { createRequire } from "module"

const require = createRequire(import.meta.url)

function detect() {
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows",
  }
  const archMap = {
    x64: "x64",
    arm64: "arm64",
    arm: "arm",
  }

  const platform = platformMap[os.platform()] || os.platform()
  const arch = archMap[os.arch()] || os.arch()
  return { platform, arch }
}

function name() {
  const { platform, arch } = detect()
  return `openwork-orchestrator-${platform}-${arch}`
}

try {
  const pkg = name()
  require.resolve(`${pkg}/package.json`)
  console.log(`openwork-orchestrator: verified platform package: ${pkg}`)
} catch (error) {
  const pkg = name()
  console.error(
    `openwork-orchestrator: failed to locate platform binary package (${pkg}).\n` +
      `Your package manager may have skipped optionalDependencies.\n` +
      `Try installing it manually: npm i -g ${pkg}`,
  )
  process.exit(1)
}
