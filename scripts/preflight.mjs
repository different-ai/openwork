#!/usr/bin/env node
/**
 * Preflight check for OpenWork development environment
 * Validates required tools and provides actionable guidance
 *
 * Usage: pnpm preflight
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

// Support NO_COLOR and CI environments
const shouldUseColor = process.stdout.isTTY && !process.env.NO_COLOR && !process.env.CI;

const GREEN = shouldUseColor ? '\x1b[32m' : '';
const RED = shouldUseColor ? '\x1b[31m' : '';
const YELLOW = shouldUseColor ? '\x1b[33m' : '';
const CYAN = shouldUseColor ? '\x1b[36m' : '';
const RESET = shouldUseColor ? '\x1b[0m' : '';
const BOLD = shouldUseColor ? '\x1b[1m' : '';

/**
 * Tool definitions
 * - cmd: command to check if tool is available
 * - min: minimum version (optional, for display purposes)
 * - hint: guidance when tool is missing
 * - installHint: installation instructions
 */
const REQUIRED_TOOLS = {
  node: {
    cmd: 'node --version',
    min: '18',
    hint: 'Node.js is required for running the build tools',
    installHint: 'Install from https://nodejs.org or use nvm',
  },
  pnpm: {
    cmd: 'pnpm --version',
    min: '10.27.0',
    hint: 'pnpm is the package manager for this project',
    installHint: 'Run: npm install -g pnpm@10.27.0',
  },
  bun: {
    cmd: 'bun --version',
    min: '1.3.9',
    hint: 'Bun is required for running server and scripts',
    installHint: 'Run: curl -fsSL https://bun.sh/install | bash',
  },
};

const OPTIONAL_TOOLS = {
  cargo: {
    cmd: 'cargo --version',
    hint: 'Required for Tauri desktop development',
    installHint: 'Install Rust from https://rustup.rs',
  },
  opencode: {
    cmd: 'opencode --version',
    hint: 'Required for running OpenCode integration',
    installHint: 'See https://github.com/anomalyco/opencode for installation',
  },
  tauri: {
    // Check if tauri CLI is available (either via global install or cargo)
    cmd: 'tauri --version 2>/dev/null || cargo tauri --version 2>/dev/null',
    useShell: true,
    hint: 'Required for Tauri CLI (desktop development)',
    installHint: 'Run: cargo install tauri-cli',
  },
};

/**
 * Execute a command and return the output or null if it fails
 * @param {string} cmd - Command to execute
 * @param {boolean} useShell - Whether to use shell for commands with pipes/operators
 */
function execCommand(cmd, useShell = false) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
      shell: useShell,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Parse version string to comparable parts
 * Handles formats: "v1.2.3", "1.2.3", "tool 1.2.3", "tool-cli 1.2.3"
 */
function parseVersion(output) {
  if (!output) return null;
  // Extract version number (first sequence of digits and dots)
  const match = output.match(/(\d+(?:\.\d+)*)/);
  return match ? match[1] : null;
}

/**
 * Compare two semver-like versions
 * @returns -1 if a < b, 0 if equal, 1 if a > b
 */
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/**
 * Check a single tool
 */
function checkTool(name, config, required = true) {
  const useShell = config.useShell || false;
  const output = execCommand(config.cmd, useShell);

  if (output) {
    // Extract version from output (usually first line)
    const firstLine = output.split('\n')[0];
    const version = parseVersion(firstLine);

    // Check minimum version if specified
    if (config.min && version) {
      if (compareVersions(version, config.min) < 0) {
        console.log(`  ${RED}✗${RESET} ${CYAN}${name}${RESET}: ${version} (requires ${config.min}+)`);
        if (config.installHint) {
          console.log(`    ${YELLOW}→${RESET} ${config.installHint}`);
        }
        return false;
      }
    }

    console.log(`  ${GREEN}✓${RESET} ${CYAN}${name}${RESET}: ${firstLine}`);
    return true;
  } else {
    if (required) {
      console.log(`  ${RED}✗${RESET} ${CYAN}${name}${RESET}: not found`);
      if (config.hint) {
        console.log(`    ${YELLOW}→${RESET} ${config.hint}`);
      }
      if (config.installHint) {
        console.log(`    ${YELLOW}→${RESET} ${config.installHint}`);
      }
      return false;
    } else {
      console.log(`  ${YELLOW}○${RESET} ${CYAN}${name}${RESET}: not found (optional)`);
      if (config.hint) {
        console.log(`    ${YELLOW}→${RESET} ${config.hint}`);
      }
      return true;
    }
  }
}

/**
 * Main preflight check
 */
function main() {
  console.log(`\n${BOLD}🔍 OpenWork Preflight Check${RESET}\n`);
  console.log(`Platform: ${platform()}\n`);

  let allPassed = true;

  // Check required tools
  console.log(`${BOLD}Required tools:${RESET}`);
  for (const [name, config] of Object.entries(REQUIRED_TOOLS)) {
    if (!checkTool(name, config, true)) {
      allPassed = false;
    }
  }

  // Check optional tools
  console.log(`\n${BOLD}Optional tools:${RESET}`);
  for (const [name, config] of Object.entries(OPTIONAL_TOOLS)) {
    checkTool(name, config, false);
  }

  console.log('');

  if (!allPassed) {
    console.log(`${RED}${BOLD}✗ Preflight failed${RESET}`);
    console.log('Please install missing required tools before continuing.\n');
    process.exit(1);
  }

  console.log(`${GREEN}${BOLD}✓ Preflight passed${RESET}`);
  console.log('Your environment is ready for development.\n');
}

main();
