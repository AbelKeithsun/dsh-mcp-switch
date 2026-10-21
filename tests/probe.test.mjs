/**
 * Tests for probe.js — the independent MCP connection used by the preview.
 *
 * The stdio transport talks to a real child process (tests/fixtures/
 * mcp-stdio-server.mjs); the HTTP transport talks to a local node:http server
 * that speaks Streamable HTTP in both JSON and SSE response modes. No external
 * service and no network beyond 127.0.0.1.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { configFingerprint, probeServer } from '../probe.js'

const fixture = new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url).pathname

/** Read a JSON request body. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

/** Start a local Streamable HTTP MCP fixture. */
async function startHttpServer({ sse = false, token = 'Bearer test-token', tools = 2 } = {}) {
  let session
  let seenSessionHeader = false
  const server = createServer(async (request, response) => {
    if (request.method === 'DELETE') {
      response.writeHead(204).end()
      return
    }
    const authorization = request.headers.authorization
    if (authorization !== token) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'unauthorized', message: 'bad token' } }))
      return
    }
    if (request.headers['mcp-session-id'] !== undefined) {
      seenSessionHeader = request.headers['mcp-session-id'] === session
      if (!seenSessionHeader) {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'bad session' } }))
        return
      }
    }
    const message = await readBody(request)
    const send = (payload) => {
      if (!sse) {
        response.writeHead(200, { 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) })
        response.end(JSON.stringify(payload))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) })
      response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    if (message.method === 'initialize') {
      session = 'session-123'
      response.setHeader('mcp-session-id', session)
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture-http', version: '9.9.9' },
        },
      })
      return
    }
    if (message.method === 'notifications/initialized') {
      response.writeHead(202).end()
      return
    }
    if (message.method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          tools: Array.from({ length: tools }, (_, index) => ({
            name: `http_tool_${index + 1}`,
            description: `HTTP fixture tool ${index + 1}`,
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: index === 0 ? ['text'] : [],
            },
          })),
        },
      })
      return
    }
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'unsupported method' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    sawSession: () => seenSessionHeader,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

test('configFingerprint ignores key order and changes with any transport setting', () => {
  const base = { transport: 'stdio', command: 'node', args: ['a', 'b'], env: { A: '1', B: '2' } }
  const reordered = { env: { B: '2', A: '1' }, args: ['a', 'b'], command: 'node', transport: 'stdio' }
  assert.equal(configFingerprint(base), configFingerprint(reordered))
  assert.notEqual(configFingerprint(base), configFingerprint({ ...base, command: 'other' }))
  assert.notEqual(configFingerprint(base), configFingerprint({ ...base, env: { A: '1', B: '3' } }))
})

test('stdio probe spawns the server, paginates tools/list and shuts it down', async () => {
  const result = await probeServer({
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
  })
  assert.equal(result.serverInfo.name, 'fixture-stdio')
  assert.equal(result.serverInfo.version, '1.2.3')
  assert.equal(result.protocolVersion, '2025-06-18')
  assert.deepEqual(result.tools.map((tool) => tool.name), ['alpha', 'beta'])
  assert.deepEqual(result.tools[0].parameters, [
    { name: 'query', required: true },
    { name: 'limit', required: false },
  ])
  assert.equal(result.tools[1].description, 'Second fixture tool')
})

test('stdio probe reports the server stderr when the command cannot serve', async () => {
  await assert.rejects(
    probeServer({
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_MODE: 'fail' },
    }),
    /server stderr: fixture: refusing to start/,
  )
})

test('streamable-http probe sends the configured auth header and reads tools', async () => {
  const server = await startHttpServer()
  try {
    const result = await probeServer({
      transport: 'streamable-http',
      url: server.url,
      headers: { authorization: 'Bearer test-token' },
    })
    assert.equal(result.serverInfo.name, 'fixture-http')
    assert.deepEqual(result.tools.map((tool) => tool.name), ['http_tool_1', 'http_tool_2'])
    assert.deepEqual(result.tools[0].parameters, [{ name: 'text', required: true }])
    assert.equal(server.sawSession(), true, 'tools/list must carry the session id from initialize')
  } finally {
    await server.close()
  }
})

test('streamable-http probe accepts a single-shot SSE response', async () => {
  const server = await startHttpServer({ sse: true })
  try {
    const result = await probeServer(
      { transport: 'streamable-http', url: server.url, headers: { authorization: 'Bearer test-token' } },
      { timeoutMs: 5000 },
    )
    assert.deepEqual(result.tools.map((tool) => tool.name), ['http_tool_1', 'http_tool_2'])
  } finally {
    await server.close()
  }
})

test('streamable-http probe surfaces an auth failure instead of an empty list', async () => {
  const server = await startHttpServer()
  try {
    await assert.rejects(
      probeServer({ transport: 'streamable-http', url: server.url, headers: { authorization: 'Bearer wrong' } }),
      /HTTP 401/,
    )
  } finally {
    await server.close()
  }
})
