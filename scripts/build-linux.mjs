#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const electronVersion = '33.4.11';
const supportedArchs = new Set(['x64', 'arm64']);
const requestedArchs = process.argv
  .slice(2)
  .map((arg) => arg.replace(/^--/, ''))
  .filter((arg) => supportedArchs.has(arg));
const archs = requestedArchs.length > 0 ? requestedArchs : ['x64'];

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32' || process.platform === 'linux',
  });

  if (result.error) {
    console.error(`[build:linux] ${command} failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Step 1: 清理舊建構
run('node', ['scripts/prebuild-clean.mjs']);

// Step 2: 跳過 macOS Speech（build-macos-speech.mjs 在非 macOS 上已自動跳過）
if (process.platform === 'darwin') {
  run('node', ['scripts/build-macos-speech.mjs']);
} else {
  console.log('[build:linux] skipping macOS speech build on', process.platform);
}

for (const arch of archs) {
  // Step 3: 重建 better-sqlite3
  console.log(`[build:linux] rebuilding better-sqlite3 for ${arch}`);
  run('node', [
    './node_modules/@electron/rebuild/lib/cli.js',
    '-f',
    '-w',
    'better-sqlite3',
    '-v',
    electronVersion,
    '-a',
    arch,
  ]);

  // Step 4: 打包 AppImage + deb
  console.log(`[build:linux] packaging ${arch} AppImage + deb`);
  run('node', ['./node_modules/electron-builder/cli.js', '--linux', `--${arch}`]);
}
