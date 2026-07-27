import { existsSync, readFileSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BACKUP_DIR = resolve(__dirname, '.cache-bs3')
const ROOT = resolve(__dirname, '..')

// Only run on macOS (cross-compile)
if (process.platform === 'win32') {
  console.log('[postbuild-fix-win] skip — running on Windows, native binary should be correct')
  process.exit(0)
}

if (!existsSync(BACKUP_DIR)) {
  console.log('[postbuild-fix-win] no backup found in', BACKUP_DIR)
  console.log('[postbuild-fix-win] (this is normal if install-win-native was already run on a previous build)')
  process.exit(0)
}

const backupNode = resolve(BACKUP_DIR, 'better_sqlite3.node')
if (!existsSync(backupNode)) {
  console.log('[postbuild-fix-win] backup better_sqlite3.node not found')
  process.exit(0)
}

const backupSize = readFileSync(backupNode).length
console.log(`[postbuild-fix-win] backup size: ${backupSize} bytes`)

// Search for the target in common output locations
const searchPaths = [
  resolve(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  resolve(ROOT, 'dist', 'win-unpacked', 'resources', 'app', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
]

let targetNode = null
for (const p of searchPaths) {
  if (existsSync(p)) {
    targetNode = p
    break
  }
}

if (!targetNode) {
  console.log('[postbuild-fix-win] target better_sqlite3.node not found in dist/')
  console.log('[postbuild-fix-win] searching for any better_sqlite3.node in dist/...')
  // Search recursively
  const distDir = resolve(ROOT, 'dist')
  if (existsSync(distDir)) {
    const found = findNodeFiles(distDir)
    if (found.length > 0) {
      console.log('[postbuild-fix-win] found better_sqlite3.node at:')
      for (const f of found) {
        console.log(`  ${f}`)
        targetNode = f
        break
      }
    } else {
      console.log('[postbuild-fix-win] no better_sqlite3.node found in dist/')
      process.exit(0)
    }
  } else {
    console.log('[postbuild-fix-win] dist/ directory not found')
    process.exit(0)
  }
}

const targetSize = readFileSync(targetNode).length
console.log(`[postbuild-fix-win] target size: ${targetSize} bytes (at ${targetNode})`)

if (backupSize === targetSize) {
  console.log('[postbuild-fix-win] OK — binary matches backup')
  process.exit(0)
}

console.log('[postbuild-fix-win] MISMATCH — restoring backup (electron-builder may have overwritten it)')
mkdirSync(dirname(targetNode), { recursive: true })
copyFileSync(backupNode, targetNode)
console.log('[postbuild-fix-win] done — binary restored')

function findNodeFiles(dir) {
  const results = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        results.push(...findNodeFiles(full))
      } else if (entry.name === 'better_sqlite3.node') {
        results.push(full)
      }
    }
  } catch {}
  return results
}
