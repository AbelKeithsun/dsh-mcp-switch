/**
 * A tiny stdio MCP server for probe tests: newline-delimited JSON-RPC on
 * stdin/stdout, two pages of `tools/list`, no dependencies.
 *
 * Environment:
 *   FIXTURE_MODE=fail  → print a diagnostic to stderr and exit before replying.
 */
import { stdin, stdout, stderr } from 'node:process'

const mode = process.env.FIXTURE_MODE ?? 'ok'

function send(message) {
  stdout.write(JSON.stringify(message) + '\n')
}

if (mode === 'fail') {
  stderr.write('fixture: refusing to start as requested\n')
  process.exit(2)
}

let buffer = ''
stdin.setEncoding('utf8')
stdin.on('data', (chunk) => {
  buffer += chunk
  let newline
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim()
    buffer = buffer.slice(newline + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    if (message.method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fixture-stdio', version: '1.2.3' },
        },
      })
      continue
    }
    if (message.method === 'tools/list') {
      const cursor = message.params?.cursor
      if (cursor === undefined) {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'alpha',
                description: 'First fixture tool',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' }, limit: { type: 'number' } },
                  required: ['query'],
                },
              },
            ],
            nextCursor: 'page-2',
          },
        })
      } else {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              {
                name: 'beta',
                description: 'Second fixture tool',
                inputSchema: { type: 'object', properties: {} },
              },
            ],
          },
        })
      }
    }
  }
})
