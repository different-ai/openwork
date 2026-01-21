#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const CONFIG_PATH = 'src-tauri/tauri.conf.json';
const BACKUP_PATH = 'src-tauri/tauri.conf.json.backup';

function addExternalBin(config) {
  if (config.bundle?.externalBin?.includes('sidecars/opencode')) {
    return config; // Already has externalBin
  }

  return {
    ...config,
    bundle: {
      ...config.bundle,
      externalBin: ['sidecars/opencode']
    }
  };
}

function main() {
  console.log('🔧 Preparing release build with sidecar...');

  // Read current config
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));

  // Backup original config
  fs.writeFileSync(BACKUP_PATH, JSON.stringify(config, null, 2));
  console.log('✅ Backed up tauri.conf.json');

  // Add externalBin
  const releaseConfig = addExternalBin(config);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(releaseConfig, null, 2));
  console.log('✅ Added externalBin to tauri.conf.json');

  console.log('✨ Ready for release build');
}

main();
