/**
 * Behaviour tests for the Host half of @local/dsh-mcp-switch.
 *
 * The Host half registers one read-only HTTP route and reads two Host
 * services (`loader`, `tools`). These tests drive the real `apply()` against
 * fake services: no DSH process, no network. Run: node --test tests/
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply } from '../index.js'

const fixture = new URL('./fixtures/mcp-stdio-server.mjs', import.meta.url).pathname

const MCP = '@deepseek-ai/dsh-mcp-client'
const ROUTE = '/api/mcp-switch/servers'

/** One Loader entry as the real Loader reports it. */
function entry(id, config, extra = {}) {
  return {
    id,
    disabled: false,
    options: { name: MCP, config },
    ...extra,
  }
}

/** Tool schemas as `ctx.tools.schemas()` returns them. */
function tool(name, description, parameters = { type: 'object', properties: {} }) {
  return { name, description, parameters }
}

/**
 * Mount the real Host half over fake services.
 * @returns {{ routes: Array<object>, listeners: Record<string, Function[]>, services: object }}
 */
function mountHost({ entries, schemas }) {
  const routes = []
  const listeners = {}
  const home = mkdtempSync(join(tmpdir(), 'mcp-switch-host-'))
  process.env.DSH_HOME = home
  const webServer = {
    register: (route) => {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
  const services = {
    schemas,
    entries,
    webServer,
    tools: { schemas: () => services.schemas },
    loader: { entries: () => services.entries },
  }
  const ctx = {
    get: (name) => services[name],
    inject: (names, callback) => {
      for (const name of names) {
        assert.ok(services[name] !== undefined, `missing service ${name}`)
      }
      callback(ctx)
    },
    effect: (callback) => {
      callback()
    },
    on: (name, listener) => {
      ;(listeners[name] ??= []).push(listener)
      return () => {
        listeners[name] = listeners[name].filter((candidate) => candidate !== listener)
      }
    },
    webServer,
  }
  apply(ctx)
  return { routes, listeners, services, home }
}

/** A fake Node request carrying an optional JSON body. */
function fakeRequest({ method, remoteAddress, host, headers, body }) {
  const request = {
    method,
    socket: { remoteAddress },
    headers: { host, ...headers },
    on(event, listener) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(body))
      if (event === 'end') queueMicrotask(listener)
      return request
    },
    destroy() {},
  }
  return request
}

/** A fake Node response that records status, headers and body. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, nextHeaders) {
      this.status = status
      this.headers = nextHeaders
    },
    end(payload) {
      this.body = payload
    },
  }
}

/** Invoke the registered route synchronously (GET paths answer synchronously). */
function call(route, options = {}) {
  const {
    method = 'GET',
    remoteAddress = '127.0.0.1',
    host = '127.0.0.1:57765',
    headers = {},
    body,
  } = options
  const response = fakeResponse()
  route.handler(fakeRequest({ method, remoteAddress, host, headers, body }), response)
  return {
    status: response.status,
    headers: response.headers,
    body: response.body === '' ? undefined : JSON.parse(response.body),
  }
}

/** Invoke the route and wait for its asynchronous answer. */
function callAsync(route, options = {}) {
  const {
    method = 'POST',
    remoteAddress = '127.0.0.1',
    host = '127.0.0.1:57765',
    headers = {},
    body,
  } = options
  const response = fakeResponse()
  const answered = new Promise((resolve) => {
    const end = response.end.bind(response)
    response.end = (payload) => {
      end(payload)
      resolve()
    }
  })
  route.handler(fakeRequest({ method, remoteAddress, host, headers, body }), response)
  return answered.then(() => ({
    status: response.status,
    headers: response.headers,
    body: response.body === '' ? undefined : JSON.parse(response.body),
  }))
}

test('the Host half registers the read-only preview and probe routes', () => {
  const { routes } = mountHost({ entries: [], schemas: [] })
  assert.deepEqual(
    routes.map((route) => `${route.kind} ${route.path}`),
    [`exact ${ROUTE}`, `exact ${PROBE_ROUTE}`],
  )
})

test('lists each MCP row with the tools it registers and their parameters', () => {
  const { routes } = mountHost({
    entries: [
      entry('include:mcp-superting', {
        serverName: 'superting',
        transport: 'streamable-http',
        headers: { Authorization: 'Bearer SECRET-TOKEN' },
      }),
      entry('include:mcp-gitnexus', { serverName: 'gitnexus', transport: 'stdio' }),
      {
        id: 'include:tool-bash',
        disabled: false,
        options: { name: '@deepseek-ai/dsh-tool-bash', config: {} },
      },
    ],
    schemas: [
      tool('bash', 'Run a shell command'),
      tool('mcp__superting__search_notes', 'Search notes by keyword', {
        type: 'object',
        properties: { limit: { type: 'number' }, query: { type: 'string' } },
        required: ['query'],
      }),
      tool('mcp__superting__list_notes', 'List notes'),
      tool('mcp__gitnexus__explain', 'Explain a symbol'),
    ],
  })

  const answer = call(routes[0])
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.route, ROUTE)
  assert.ok(answer.body.asOf > 0)
  assert.equal(answer.body.servers.length, 2)

  const [superting, gitnexus] = answer.body.servers
  assert.equal(superting.entryId, 'include:mcp-superting')
  assert.equal(superting.serverName, 'superting')
  assert.equal(superting.transport, 'streamable-http')
  assert.equal(superting.enabled, true)
  assert.deepEqual(
    superting.tools.map((row) => row.name),
    ['list_notes', 'search_notes'],
  )
  assert.equal(superting.tools[1].description, 'Search notes by keyword')
  assert.deepEqual(superting.tools[1].parameters, [
    { name: 'limit', required: false },
    { name: 'query', required: true },
  ])
  assert.equal(superting.tools[1].publicName, 'mcp__superting__search_notes')
  assert.deepEqual(gitnexus.tools.map((row) => row.name), ['explain'])
})

test('never forwards profile secrets, env, headers or commands', () => {
  const { routes } = mountHost({
    entries: [
      entry('include:mcp-superting', {
        serverName: 'superting',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:8220/mcp?token=SECRET-URL',
        headers: { Authorization: 'Bearer SECRET-TOKEN' },
        env: { SUPER_SECRET: 'SECRET-ENV' },
      }),
      entry('include:rea-mcp', {
        serverName: 'rea',
        transport: 'stdio',
        command: '/usr/bin/node',
        args: ['/secret/path/rea.mjs', '--token=SECRET-ARG'],
        cwd: '/secret/cwd',
      }),
    ],
    schemas: [tool('mcp__superting__list_notes', 'List notes')],
  })

  const raw = JSON.stringify(call(routes[0]).body)
  for (const forbidden of [
    'SECRET',
    'Authorization',
    'headers',
    'env',
    'command',
    'args',
    'cwd',
    '127.0.0.1:8220',
  ]) {
    assert.equal(raw.includes(forbidden), false, `payload leaked ${forbidden}`)
  }
  assert.match(raw, /"serverName":"superting"/)
})

test('a disabled server keeps its last-seen tool list and is marked disabled', () => {
  const first = mountHost({
    entries: [entry('include:mcp-superting', { serverName: 'superting', transport: 'stdio' })],
    schemas: [tool('mcp__superting__list_notes', 'List notes')],
  })
  const live = call(first.routes[0]).body.servers[0]
  assert.equal(live.tools.length, 1)
  assert.equal(live.cached, undefined)

  // Toggling the row off disposes the MCP client: its tools disappear.
  first.services.schemas = []
  first.services.entries[0].disabled = true
  const cached = call(first.routes[0]).body.servers[0]
  assert.equal(cached.enabled, false)
  assert.deepEqual(cached.tools, [])
  assert.deepEqual(cached.cached.tools.map((row) => row.name), ['list_notes'])
  assert.ok(cached.cached.asOf > 0)

  // Re-enabling with different tools replaces the snapshot.
  first.services.entries[0].disabled = false
  first.services.schemas = [tool('mcp__superting__list_notes', 'List notes'), tool('mcp__superting__read_note', 'Read a note')]
  const again = call(first.routes[0]).body.servers[0]
  assert.equal(again.tools.length, 2)
  assert.equal(again.cached, undefined)
})

test('the tools/change listener warms the cache without a page request', () => {
  const { routes, listeners, services } = mountHost({
    entries: [entry('include:rea-mcp', { serverName: 'rea', transport: 'stdio' })],
    schemas: [],
  })
  assert.equal(call(routes[0]).body.servers[0].cached, undefined)
  assert.equal(listeners['tools/change'].length, 1)

  services.schemas = [tool('mcp__rea__decompile', 'Decompile a binary')]
  for (const listener of listeners['tools/change']) listener()

  services.schemas = []
  services.entries[0].disabled = true
  const row = call(routes[0]).body.servers[0]
  assert.deepEqual(row.cached.tools.map((row) => row.name), ['decompile'])
})

test('teardown events do not shrink the cached snapshot', () => {
  const { routes, listeners, services } = mountHost({
    entries: [entry('include:mcp-superting', { serverName: 'superting' })],
    schemas: [tool('mcp__superting__list_notes', 'List notes'), tool('mcp__superting__read_note', 'Read a note')],
  })
  assert.equal(call(routes[0]).body.servers[0].tools.length, 2)

  // Disabling unregisters the tools one by one; each unregister fires the
  // listener. The cached snapshot must stay at the full generation.
  services.schemas = [tool('mcp__superting__read_note', 'Read a note')]
  for (const listener of listeners['tools/change']) listener()
  services.schemas = []
  for (const listener of listeners['tools/change']) listener()
  services.entries[0].disabled = true
  const cached = call(routes[0]).body.servers[0]
  assert.equal(cached.enabled, false)
  assert.deepEqual(cached.cached.tools.map((row) => row.name), ['list_notes', 'read_note'])

  // A new enabled generation replaces the old snapshot, even when smaller.
  services.entries[0].disabled = false
  services.schemas = [tool('mcp__superting__health', 'Check health')]
  for (const listener of listeners['tools/change']) listener()
  const again = call(routes[0]).body.servers[0]
  assert.deepEqual(again.tools.map((row) => row.name), ['health'])
  assert.equal(again.cached, undefined)
})

test('the route refuses non-loopback peers, cross-site fetches and other methods', () => {
  const { routes } = mountHost({ entries: [], schemas: [] })
  const route = routes[0]

  assert.equal(call(route, { remoteAddress: '192.168.1.20' }).status, 403)
  assert.equal(call(route, { remoteAddress: '10.0.0.5' }).status, 403)
  assert.equal(call(route, { host: '192.168.1.20:57765' }).status, 403)
  assert.equal(call(route, { headers: { 'sec-fetch-site': 'cross-site' } }).status, 403)
  assert.equal(call(route, { headers: { origin: 'http://evil.example' } }).status, 403)
  assert.equal(call(route, { method: 'POST' }).status, 405)

  const sameOrigin = call(route, { headers: { origin: 'http://127.0.0.1:57765', 'sec-fetch-site': 'same-origin' } })
  assert.equal(sameOrigin.status, 200)
  assert.equal(sameOrigin.headers['cache-control'], 'no-store')
  assert.match(sameOrigin.headers['content-type'], /application\/json/)

  const ipv6 = call(route, { remoteAddress: '::1', host: '[::1]:57765' })
  assert.equal(ipv6.status, 200)
})

test('a broken tool registry fails the request instead of returning stale rows', () => {
  const { routes, services } = mountHost({
    entries: [entry('include:mcp-superting', { serverName: 'superting' })],
    schemas: [],
  })
  services.loader.entries = () => {
    throw new Error('loader went away')
  }
  const answer = call(routes[0])
  assert.equal(answer.status, 500)
  assert.equal(answer.body.ok, false)
  assert.match(answer.body.error, /loader went away/)
})


const PROBE_ROUTE = '/api/mcp-switch/probe'

/** The probe route of a mounted host. */
function probeRoute(routes) {
  return routes.find((route) => route.path === PROBE_ROUTE)
}

/** A disabled MCP row pointed at the stdio fixture. */
function fixtureEntry(extra = {}) {
  const row = entry('include:mcp-fixture', {
    serverName: 'fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    ...extra,
  })
  row.disabled = true
  return row
}

test('POST probe reads a disabled server tool list and persists it for GET', async () => {
  const { routes, home } = mountHost({ entries: [fixtureEntry()], schemas: [] })
  const answer = await callAsync(probeRoute(routes), {
    body: JSON.stringify({ entryId: 'include:mcp-fixture' }),
  })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.source, 'probe')
  assert.deepEqual(answer.body.probe.tools.map((tool) => tool.name), ['alpha', 'beta'])
  assert.equal(answer.body.probe.serverInfo.name, 'fixture-stdio')
  assert.ok(answer.body.probe.probedAt > 0)

  const file = join(home, 'cache', 'mcp-switch', 'probe.json')
  assert.equal(existsSync(file), true)
  const cached = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(cached.entries['include:mcp-fixture'].tools.map((tool) => tool.name), ['alpha', 'beta'])
  assert.equal(typeof cached.entries['include:mcp-fixture'].fingerprint, 'string')

  // GET merges the persisted probe; the payload carries tools only, no config.
  const list = call(routes[0])
  const row = list.body.servers[0]
  assert.deepEqual(row.probe.tools.map((tool) => tool.name), ['alpha', 'beta'])
  assert.equal(row.enabled, false)
  const raw = JSON.stringify(list.body)
  for (const forbidden of ['command', 'args', 'env', 'fixture-stdio.mjs']) {
    assert.equal(raw.includes(forbidden), false, `payload leaked ${forbidden}`)
  }

  // An unchanged config answers from the cache instead of spawning again.
  const cachedAnswer = await callAsync(probeRoute(routes), {
    body: JSON.stringify({ entryId: 'include:mcp-fixture' }),
  })
  assert.equal(cachedAnswer.body.source, 'cache')
})

test('editing the server config invalidates the probe cache', async () => {
  const { routes, services } = mountHost({ entries: [fixtureEntry()], schemas: [] })
  await callAsync(probeRoute(routes), { body: JSON.stringify({ entryId: 'include:mcp-fixture' }) })
  assert.ok(call(routes[0]).body.servers[0].probe)

  services.entries[0].options.config.args = [fixture, '--changed']
  assert.equal(call(routes[0]).body.servers[0].probe, undefined)
  const again = await callAsync(probeRoute(routes), {
    body: JSON.stringify({ entryId: 'include:mcp-fixture' }),
  })
  assert.equal(again.body.source, 'probe')
})

test('the probe route resolves !!js config expressions for disabled rows', async () => {
  const evaluated = []
  const rows = [
    {
      id: 'include:mcp-expr',
      disabled: true,
      evaluate(expr) {
        evaluated.push(expr)
        return eval(expr)
      },
      options: {
        name: MCP,
        config: {
          serverName: 'fixture',
          transport: { __jsExpr: '"stdio"' },
          command: { __jsExpr: 'process.execPath' },
          args: { __jsExpr: `[${JSON.stringify(fixture)}]` },
        },
      },
    },
  ]
  const { routes } = mountHost({ entries: rows, schemas: [] })
  const answer = await callAsync(probeRoute(routes), {
    body: JSON.stringify({ entryId: 'include:mcp-expr' }),
  })
  assert.equal(answer.body.ok, true, JSON.stringify(answer.body))
  assert.deepEqual(answer.body.probe.tools.map((tool) => tool.name), ['alpha', 'beta'])
  assert.ok(evaluated.length >= 3)
})

test('the probe route fences methods, peers and bad requests', async () => {
  const { routes } = mountHost({ entries: [fixtureEntry()], schemas: [] })
  const route = probeRoute(routes)

  const ok = { body: JSON.stringify({ entryId: 'include:mcp-fixture' }) }
  assert.equal((await callAsync(route, { ...ok, remoteAddress: '192.168.1.9' })).status, 403)
  assert.equal((await callAsync(route, { ...ok, host: '10.0.0.4:57765' })).status, 403)
  assert.equal((await callAsync(route, { ...ok, headers: { origin: 'http://evil.example' } })).status, 403)
  assert.equal((await callAsync(route, { ...ok, method: 'GET' })).status, 405)
  assert.equal((await callAsync(route, { body: 'not json' })).status, 400)
  assert.equal((await callAsync(route, { body: JSON.stringify({}) })).status, 400)
  assert.equal((await callAsync(route, { body: JSON.stringify({ entryId: 'include:missing' }) })).status, 404)
})

test('GET folds live tools into the probe cache so a later disable still previews', () => {
  const { routes, services, home } = mountHost({
    entries: [fixtureEntry()],
    schemas: [tool('mcp__fixture__alpha', 'First fixture tool')],
  })
  services.entries[0].disabled = false
  call(routes[0]) // live tools observed while enabled
  services.entries[0].disabled = true
  services.schemas = []
  assert.ok(call(routes[0]).body.servers[0].cached)
  const file = join(home, 'cache', 'mcp-switch', 'probe.json')
  assert.equal(existsSync(file), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries['include:mcp-fixture'].tools.map((row) => row.name), ['alpha'])
})
