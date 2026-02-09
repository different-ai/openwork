#!/usr/bin/env node
// Cross-platform dev script for Tauri
// Handles PORT environment variable on Windows, macOS, and Linux

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { writeFileSync, unlinkSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Get PORT from environment or default to 5173
const port = process.env.PORT || '5173';
const devUrl = `http://localhost:${port}`;

console.log(`Starting Tauri dev server on ${devUrl}...`);

// Check if using system opencode (local dev mode)
const useSystemOpencode = process.env.USE_SYSTEM_OPENCODE === 'true' || process.env.OPENCODE_BIN_PATH;

// Check if sidecars are already prepared
const sidecarsDir = join(projectRoot, 'src-tauri', 'sidecars');
const requiredSidecars = ['openwork-server.exe'];
const missingSidecars = requiredSidecars.filter(name => !existsSync(join(sidecarsDir, name)));

if (useSystemOpencode) {
  console.log('Using system opencode (local dev mode)');
  if (process.env.OPENCODE_BIN_PATH) {
    console.log(`OPENCODE_BIN_PATH: ${process.env.OPENCODE_BIN_PATH}`);
  }
} else if (missingSidecars.length > 0) {
  console.log(`Missing sidecars: ${missingSidecars.join(', ')}`);
  console.log('Please run "pnpm run prepare:sidecar" manually to build all sidecars.');
  console.log('Or set USE_SYSTEM_OPENCODE=true to use system-installed opencode.');
  console.log('Continuing with available sidecars...');
} else {
  console.log('Required sidecars are present.');
}

// Build the Tauri config override as proper JSON
// We override beforeDevCommand to only run dev:ui (skip prepare:sidecar since we already ran it)
const configObj = {
  build: {
    devUrl: devUrl,
    beforeDevCommand: "pnpm -w dev:ui"
  }
};

const configPath = join(projectRoot, 'tauri.dev.config.json');

// Write config to a temporary file
writeFileSync(configPath, JSON.stringify(configObj, null, 2));

console.log(`Using config file: ${configPath}`);

// On Windows, spawn needs shell:true to resolve .cmd files properly
const isWindows = process.platform === 'win32';

const tauri = spawn('tauri', ['dev', '--config', configPath], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: isWindows
});

tauri.on('close', (code) => {
  // Clean up temp config file
  try {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  } catch (e) {
    // Ignore cleanup errors
  }
  process.exit(code);
});

tauri.on('error', (err) => {
  console.error('Failed to start Tauri:', err);
  // Clean up temp config file on error
  try {
    if (existsSync(configPath)) {
      unlinkSync(configPath);
    }
  } catch (e) {
    // Ignore cleanup errors
  }
  process.exit(1);
});
