import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TMP = resolve('/tmp')

async function downloadTgz(name, ver, targetDir) {
  if (existsSync(targetDir)) {
    console.log(`  ${name}@${ver} already installed, skip`)
    return
  }
  const encodedName = name.replace('/', '%2f')
  const shortName = name.split('/')[1]
  const url = `https://registry.npmjs.org/${encodedName}/-/${shortName}-${ver}.tgz`
  console.log(`  downloading ${url}...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  const tgzPath = resolve(TMP, `${shortName}-${ver}.tgz`)
  writeFileSync(tgzPath, tgz)
  mkdirSync(targetDir, { recursive: true })
  execSync(`tar -xzf "${tgzPath}" --strip-components=1 -C "${targetDir}"`, { stdio: 'pipe' })
  try { execSync(`rm "${tgzPath}"`) } catch {}
  console.log(`  ${name}@${ver} installed`)
}

async function installSharpWin32() {
  console.log('[install-win-native] installing win32-x64 sharp deps...')
  const sharpPkg = resolve(ROOT, 'node_modules', 'sharp', 'package.json')
  const { optionalDependencies } = JSON.parse(readFileSync(sharpPkg, 'utf-8'))
  const winDeps = Object.entries(optionalDependencies || {})
    .filter(([name]) => name.includes('win32-x64'))
  if (winDeps.length === 0) { console.log('  no win32-x64 sharp deps found'); return }
  for (const [name, ver] of winDeps) {
    await downloadTgz(name, ver, resolve(ROOT, 'node_modules', ...name.split('/')))
  }
}

async function installBetterSqlite3Win32() {
  console.log('[install-win-native] installing better-sqlite3 win32-x64 for Electron 33...')
  const pkgDir = resolve(ROOT, 'node_modules', 'better-sqlite3')
  const { version } = JSON.parse(readFileSync(resolve(pkgDir, 'package.json'), 'utf-8'))
  const abi = '132' // Electron 33 ABI
  const filename = `better-sqlite3-v${version}-electron-v${abi}-win32-x64.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}`
  const tgzPath = resolve(TMP, filename)
  console.log(`  downloading ${url}...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  writeFileSync(tgzPath, tgz)
  execSync(`tar -xzf "${tgzPath}" -C "${pkgDir}"`, { stdio: 'pipe' })
  try { execSync(`rm "${tgzPath}"`) } catch {}
  const nodeFile = resolve(pkgDir, 'build', 'Release', 'better_sqlite3.node')
  if (existsSync(nodeFile)) {
    console.log(`  better-sqlite3@${version} win32-x64 binary installed`)
  } else {
    console.log(`  extracted but no .node file at build/Release/, checking structure...`)
    execSync(`find "${pkgDir}" -name "*.node" 2>/dev/null`, { stdio: 'inherit' })
    // older releases extract to different paths; try find and copy
    const found = execSync(`find "${pkgDir}" -name "*.node" 2>/dev/null`, { encoding: 'utf-8' }).trim().split('\n').filter(Boolean)
    if (found.length > 0) {
      mkdirSync(resolve(pkgDir, 'build', 'Release'), { recursive: true })
      for (const f of found) execSync(`cp "${f}" "${pkgDir}/build/Release/"`, { stdio: 'pipe' })
      console.log(`  copied .node files to build/Release/`)
    }
  }
}

await installSharpWin32()
await installBetterSqlite3Win32()
console.log('[install-win-native] done')
