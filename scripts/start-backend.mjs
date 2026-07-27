#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
if (process.platform === 'win32') spawnSync('chcp', ['65001'], { stdio: 'pipe', shell: true })
const args = ['--env-file=.env', 'src/index.js']
if (process.argv.includes('--watch')) args.unshift('--watch')
spawnSync('node', args, { stdio: 'inherit', shell: true })
