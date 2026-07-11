import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const sharpPkg = resolve(ROOT, 'node_modules', 'sharp', 'package.json')
const { optionalDependencies } = JSON.parse(readFileSync(sharpPkg, 'utf-8'))

const winDeps = Object.entries(optionalDependencies || {})
  .filter(([name]) => name.includes('win32-x64'))
  .map(([name, ver]) => [name, ver])

if (winDeps.length === 0) {
  console.log('[install-win-native] no win32-x64 sharp deps found')
  process.exit(0)
}

for (const [name, ver] of winDeps) {
  const targetDir = resolve(ROOT, 'node_modules', ...name.split('/'))
  if (existsSync(targetDir)) {
    console.log(`[install-win-native] ${name}@${ver} already installed, skipping`)
    continue
  }
  console.log(`[install-win-native] downloading ${name}@${ver}...`)
  // Fetch directly from npm registry to avoid npm CLI script policies
  const encodedName = name.replace('/', '%2f')
  const url = `https://registry.npmjs.org/${encodedName}/-/${name.split('/')[1]}-${ver}.tgz`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${name}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  const tgzPath = resolve('/tmp', `${name.split('/')[1]}-${ver}.tgz`)
  writeFileSync(tgzPath, tgz)
  mkdirSync(targetDir, { recursive: true })
  execSync(`tar -xzf "${tgzPath}" --strip-components=1 -C "${targetDir}"`, { stdio: 'inherit' })
  try { execSync(`rm "${tgzPath}"`) } catch {}
  console.log(`[install-win-native] ${name}@${ver} installed`)
}
console.log('[install-win-native] done')
