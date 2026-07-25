import assert from 'node:assert/strict'
import {
  BUILTIN_TOOL_NAMES,
  LEGACY_TOOL_ALIASES,
  TOOL_SCHEMAS,
  buildBuiltinToolSchemas,
} from './capabilities/builtin-tools.js'
import { getToolSchemas } from './capabilities/schemas.js'
import { validateToolManifest } from './capabilities/marketplace/index.js'

const builtinNames = Object.keys(TOOL_SCHEMAS)
const functionNames = builtinNames.map(name => TOOL_SCHEMAS[name]?.function?.name)

assert.equal(new Set(builtinNames).size, builtinNames.length)
assert.equal(new Set(functionNames).size, functionNames.length)
assert.deepEqual(functionNames, builtinNames)
assert.equal(BUILTIN_TOOL_NAMES.size, builtinNames.length + LEGACY_TOOL_ALIASES.length)

assert.deepEqual(
  getToolSchemas(['browser_open', 'browser_open', 'web_read', 'browser_open'])
    .map(schema => schema.function.name),
  ['browser_open', 'web_read'],
)

assert.throws(
  () => buildBuiltinToolSchemas([
    ['first', { same_tool: { type: 'function', function: { name: 'same_tool' } } }],
    ['second', { same_tool: { type: 'function', function: { name: 'same_tool' } } }],
  ]),
  /Duplicate built-in tool "same_tool" in first and second/,
)

assert.throws(
  () => buildBuiltinToolSchemas([
    ['broken', { schema_key: { type: 'function', function: { name: 'different_name' } } }],
  ]),
  /schema key\/name mismatch/,
)

for (const name of ['find_tool', 'review_work', 'install_software', ...LEGACY_TOOL_ALIASES]) {
  assert.throws(
    () => validateToolManifest({
      name,
      description: 'conflicting extension',
      parameters: { type: 'object', properties: {} },
      code: 'return true',
    }),
    /保留名称/,
  )
}

console.log('test-tool-schema-dedup passed')
