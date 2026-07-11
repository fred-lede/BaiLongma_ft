import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sharpPkg = resolve(__dirname, '..', 'node_modules', 'sharp', 'package.json')
const { optionalDependencies } = JSON.parse(readFileSync(sharpPkg, 'utf-8'))

const winDeps = Object.entries(optionalDependencies || {})
  .filter(([name]) => name.includes('win32-x64'))
  .map(([name, ver]) => `${name}@${ver}`)

if (winDeps.length === 0) {
  console.log('[install-win-native] no win32-x64 sharp deps found')
  process.exit(0)
}

console.log(`[install-win-native] installing ${winDeps.length} win32-x64 sharp deps...`)
execSync(`npm install --ignore-scripts --no-save ${winDeps.join(' ')}`, { stdio: 'inherit', cwd: resolve(__dirname, '..') })
console.log('[install-win-native] done')
