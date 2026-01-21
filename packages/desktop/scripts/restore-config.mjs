#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const CONFIG_PATH = 'src-tauri/tauri.conf.json';
const BACKUP_PATH = 'src-tauri/tauri.conf.json.backup';

function main() {
  console.log('🔧 Restoring original config...');

  if (fs.existsSync(BACKUP_PATH)) {
    fs.copyFileSync(BACKUP_PATH, CONFIG_PATH);
    fs.unlinkSync(BACKUP_PATH);
    console.log('✅ Restored tauri.conf.json');
  } else {
    console.log('⚠️  No backup found, skipping restore');
  }
}

main();
