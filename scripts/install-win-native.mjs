import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, copyFileSync, readdirSync } from 'node:fs'

// On Windows native, npm install already provides correct native modules — skip.
if (process.platform === 'win32') {
  console.log('[install-win-native] skip — native modules already installed for Windows')
  process.exit(0)
}
import { resolve, dirname, sep, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const TMP_DIR = tmpdir()
const BS3_BACKUP_DIR = resolve(__dirname, '.cache-bs3')

function findNodeFiles(dir) {
  const results = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findNodeFiles(full))
    } else if (entry.name.endsWith('.node')) {
      results.push(full)
    }
  }
  return results
}

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
  const tgzPath = resolve(TMP_DIR, `${shortName}-${ver}.tgz`)
  writeFileSync(tgzPath, tgz)
  mkdirSync(targetDir, { recursive: true })
  execSync(`tar -xzf "${tgzPath}" --strip-components=1 -C "${targetDir}"`, { stdio: 'pipe' })
  try { unlinkSync(tgzPath) } catch {}
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
  console.log('[install-win-native] installing better-sqlite3 win32-x64 for Electron...')
  const pkgDir = resolve(ROOT, 'node_modules', 'better-sqlite3')
  const pkgJsonPath = resolve(pkgDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    console.log('  better-sqlite3 not installed, skip')
    return
  }
  const { version } = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))

  // Lookup Electron ABI
  const electronPkg = resolve(ROOT, 'node_modules', 'electron', 'package.json')
  if (!existsSync(electronPkg)) {
    console.log('  electron package not found — run npm install first')
    return
  }
  const electronVer = JSON.parse(readFileSync(electronPkg, 'utf-8')).version
  const nodeAbiDir = resolve(ROOT, 'node_modules', '@electron', 'rebuild', 'node_modules', 'node-abi')
  const abi = execSync(
    `node -e "console.log(require('${nodeAbiDir.replace(/\\/g, '/')}').getAbi('${electronVer}', 'electron'))"`,
    { encoding: 'utf-8' }
  ).trim()

  const filename = `better-sqlite3-v${version}-electron-v${abi}-win32-x64.tar.gz`
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${filename}`
  const tgzPath = resolve(TMP_DIR, filename)
  console.log(`  downloading ${url}...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const tgz = Buffer.from(await res.arrayBuffer())
  writeFileSync(tgzPath, tgz)
  execSync(`tar -xzf "${tgzPath}" -C "${pkgDir}"`, { stdio: 'pipe' })

  // Save a backup BEFORE deleting tgz so postpack hook can restore
  const backupDir = BS3_BACKUP_DIR
  mkdirSync(backupDir, { recursive: true })
  copyFileSync(tgzPath, resolve(backupDir, filename))

  try { unlinkSync(tgzPath) } catch {}

  // Find .node files and copy to build/Release/
  const nodeFiles = findNodeFiles(pkgDir)
  if (nodeFiles.length > 0) {
    const releaseDir = resolve(pkgDir, 'build', 'Release')
    mkdirSync(releaseDir, { recursive: true })
    for (const f of nodeFiles) {
      const dest = resolve(releaseDir, 'better_sqlite3.node')
      copyFileSync(f, dest)
      console.log(`  copied ${f} -> ${dest}`)
    }
    // Save the extracted .node for quick restore in postpack hook
    copyFileSync(resolve(releaseDir, 'better_sqlite3.node'), resolve(backupDir, 'better_sqlite3.node'))
    console.log(`  better-sqlite3@${version} win32-x64 binary installed (backup: ${backupDir})`)
  } else {
    console.log('  extracted but no .node files found')
  }
}

await installSharpWin32()
await installBetterSqlite3Win32()
console.log('[install-win-native] done')
