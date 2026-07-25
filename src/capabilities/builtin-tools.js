import { commsSchemas } from './schemas/comms.js'
import { filesystemSchemas } from './schemas/filesystem.js'
import { shellSchemas } from './schemas/shell.js'
import { webSchemas } from './schemas/web.js'
import { browserSchemas } from './schemas/browser.js'
import { mediaSchemas } from './schemas/media.js'
import { memorySchemas } from './schemas/memory.js'
import { uiSchemas } from './schemas/ui.js'
import { sceneSchemas } from './schemas/scene.js'
import { taskSchemas } from './schemas/task.js'
import { reviewSchemas } from './schemas/review.js'
import { remindersSchemas } from './schemas/reminders.js'
import { agentsSchemas } from './schemas/agents.js'
import { systemSchemas } from './schemas/system.js'
import { apiCapabilitySchemas } from './schemas/api-capabilities.js'

export const BUILTIN_SCHEMA_GROUPS = Object.freeze([
  ['comms', commsSchemas],
  ['filesystem', filesystemSchemas],
  ['shell', shellSchemas],
  ['web', webSchemas],
  ['browser', browserSchemas],
  ['media', mediaSchemas],
  ['memory', memorySchemas],
  ['ui', uiSchemas],
  ['scene', sceneSchemas],
  ['task', taskSchemas],
  ['review', reviewSchemas],
  ['reminders', remindersSchemas],
  ['agents', agentsSchemas],
  ['system', systemSchemas],
  ['api-capabilities', apiCapabilitySchemas],
])

// These names are still accepted by the executor for old action logs and
// persisted turns, but are deliberately absent from the model-facing schema.
export const LEGACY_TOOL_ALIASES = Object.freeze([
  'fetch_url',
  'browser_read',
  'schedule_reminder',
])

export function buildBuiltinToolSchemas(groups = BUILTIN_SCHEMA_GROUPS) {
  const catalog = {}
  const owners = new Map()
  for (const [groupName, schemas] of groups) {
    if (!schemas || typeof schemas !== 'object' || Array.isArray(schemas)) {
      throw new Error(`Invalid built-in tool schema group: ${groupName}`)
    }
    for (const [name, schema] of Object.entries(schemas)) {
      const functionName = schema?.function?.name
      if (functionName !== name) {
        throw new Error(`Built-in tool schema key/name mismatch in ${groupName}: "${name}" != "${functionName || ''}"`)
      }
      if (owners.has(name)) {
        throw new Error(`Duplicate built-in tool "${name}" in ${owners.get(name)} and ${groupName}`)
      }
      owners.set(name, groupName)
      catalog[name] = schema
    }
  }
  return catalog
}

export const TOOL_SCHEMAS = Object.freeze(buildBuiltinToolSchemas())
export const BUILTIN_TOOL_NAMES = new Set([
  ...Object.keys(TOOL_SCHEMAS),
  ...LEGACY_TOOL_ALIASES,
])
