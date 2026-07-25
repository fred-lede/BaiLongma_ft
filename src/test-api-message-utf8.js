import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blm-api-utf8-'))
process.env.BAILONGMA_USER_DIR = tmp
process.env.BAILONGMA_RESOURCES_DIR = process.cwd()
process.env.BAILONGMA_HOST = '127.0.0.1'

let server = null
let closeDBForTest = null

try {
  const { startAPI } = await import('./api.js')
  ;({ closeDBForTest } = await import('./db.js'))
  server = startAPI(0)
  await once(server, 'listening')

  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const expected = `utf8_api_probe_${Date.now()} 中文保真测试：你好，白龙马！`
  const body = JSON.stringify({
    from_id: 'ID:UTF8_API_TEST',
    channel: 'API_UTF8_TEST',
    content: expected,
  })

  const postRes = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(body)),
    },
    body,
  })
  if (postRes.status !== 200) {
    throw new Error(`POST /message failed ${postRes.status}: ${await postRes.text()}`)
  }
  const postBody = await postRes.json()
  assert(postBody.conversation_id > 0, 'POST /message returns the inserted conversation_id')

  const rowsRes = await fetch(`${baseUrl}/conversations?limit=20`)
  if (rowsRes.status !== 200) {
    throw new Error(`GET /conversations failed ${rowsRes.status}: ${await rowsRes.text()}`)
  }
  const rows = await rowsRes.json()
  const row = rows.find(item => item.channel === 'API_UTF8_TEST')

  assert(row, 'posted UTF-8 message is present in /conversations')
  assert.equal(row.id, postBody.conversation_id, 'conversation_id matches the /conversations row id')
  assert.equal(row.content, expected, 'Chinese content round-trips through /message and /conversations')
  assert.equal(row.from_id, 'ID:UTF8_API_TEST')

  const laterConversationIds = []
  for (const suffix of ['分页第二条', '分页第三条']) {
    const response = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        from_id: 'ID:UTF8_API_TEST',
        channel: 'API_UTF8_TEST',
        content: `${expected} ${suffix}`,
      }),
    })
    assert.equal(response.status, 200)
    laterConversationIds.push((await response.json()).conversation_id)
  }

  const olderPageRes = await fetch(
    `${baseUrl}/conversations?limit=1&before_id=${laterConversationIds[1]}`,
  )
  assert.equal(olderPageRes.status, 200)
  const olderPage = await olderPageRes.json()
  assert.equal(olderPage.length, 1, 'conversation cursor returns one requested row')
  assert.equal(olderPage[0].id, laterConversationIds[0], 'before_id returns the immediately older conversation')

  console.log('PASS api /message preserves UTF-8 Chinese content and /conversations supports cursor pagination')
} finally {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
  closeDBForTest?.()
  fs.rmSync(tmp, { recursive: true, force: true })
}

process.exit(process.exitCode || 0)
