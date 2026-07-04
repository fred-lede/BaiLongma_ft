#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
if (process.platform === 'win32') spawnSync('chcp', ['65001'], { stdio: 'pipe', shell: true })
spawnSync('npx', ['electron', '.'], { stdio: 'inherit', shell: true })
