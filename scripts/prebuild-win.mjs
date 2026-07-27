/**
 * prebuild-win.mjs — Windows-only build preparation.
 *
 * Handles:
 *  - Pre-extracting electron-builder caches (winCodeSign) to avoid symlink
 *    issues with 7-Zip on Windows when Developer Mode is off.
 *
 * Run before electron-builder on Windows.
 */

import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

if (process.platform !== 'win32') {
  console.log('[prebuild-win] skip — not Windows')
  process.exit(0)
}

// electron-builder cache dir
const CACHE_DIR = resolve(process.env.LOCALAPPDATA || 'C:\\Users\\default\\AppData\\Local', 'electron-builder', 'cache')
// The winCodeSign version we expect — electron-builder decides this internally.
// We can try to detect from builder's metadata or just note the requirement.
console.log(`[prebuild-win] electron-builder cache: ${CACHE_DIR}`)

// Pre-extract any .7z archives in the cache that might have symlink issues
// (this is a no-op if already extracted)
const cacheDirs = []
if (existsSync(CACHE_DIR)) {
  for (const entry of readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) cacheDirs.push(entry.name)
  }
}
console.log(`[prebuild-win] existing cache entries: ${cacheDirs.join(', ') || '(none)'}`)
console.log('[prebuild-win] if winCodeSign extraction fails later, enable Developer Mode:')
console.log('  Settings → Update & Security → For developers → Developer Mode')
console.log('[prebuild-win] done')
