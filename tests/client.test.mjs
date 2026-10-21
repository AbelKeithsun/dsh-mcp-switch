/**
 * Behaviour tests for the Client half of @local/dsh-mcp-switch.
 *
 * The module registers itself through `window.__ModuleLoader__.load`, so the
 * test supplies that global plus a minimal React and a fake browser context,
 * then drives the real `apply()`/store code against a fake `pluginManager`
 * Remote. Run: node --test tests/
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

/** A fresh module generation per mount: the Client loads the file once per page. */
let generation = 0

/** Capture the module definition the Client module loader would receive. */
async function loadModule() {
  let definition
  globalThis.window = {
    __ModuleLoader__: {
      load(next) {
        definition = next
      },
    },
  }
  await import(`../client.js?generation=${++generation}`)
  assert.equal(definition.id, '@local/dsh-mcp-switch')
  return definition
}

/** The minimum React surface the module touches. */
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
}

function fakeRequire(name) {
  if (name === 'react') return React
  throw new Error(`unexpected require(${name})`)
}

/** A Host row as `pluginManager.listPlugins` reports it. */
function pluginInfo(entryId, moduleName, extra = {}) {
  return { entryId, moduleName, enabled: true, fiberPhase: 'active', ...extra }
}

const MCP = '@deepseek-ai/dsh-mcp-client'

/** Mount the real plugin half over a fake context and return its store. */
async function mount(remote) {
  const definition = await loadModule()
  const registrations = []
  const events = []
  const ctx = {
    effect: (callback, label) => {
      const dispose = callback()
      events.push({ label, dispose })
      return dispose
    },
    on: (name) => {
      events.push({ name })
      return () => {}
    },
    locale: {
      bind: () => (key) => key,
      register: () => () => {},
    },
    remote: Object.assign({ $on: () => () => {} }, remote),
    slots: {
      inject: (owner, callback) => {
        registrations.push({ owner, entry: callback() })
      },
      register: (options, Component) => ({ options, Component }),
    },
  }
  definition.factory(fakeRequire).apply(ctx)
  assert.equal(registrations.length, 1)
  const { owner, entry } = registrations[0]
  assert.equal(owner, 'settings.section')
  assert.equal(entry.options.id, 'mcp-switch')
  assert.equal(entry.options.order, 16)
  assert.equal(typeof entry.options.label, 'function')
  return { store: entry.options.inject().store, Component: entry.Component, events, definition }
}

test('the module declares the services its page needs', async () => {
  const definition = await loadModule()
  const { inject } = definition.factory(fakeRequire)
  assert.deepEqual(inject, ['slots', 'locale', 'remote', 'remote.pluginManager'])
})

test('lists only MCP rows, naming known servers and falling back to the patch id', async () => {
  const { store } = await mount({
    pluginManager: {
      listPlugins: async () => ({
        ok: true,
        value: [
          pluginInfo('include:rea-mcp', '@deepseek-ai/dsh-mcp-client', { patchId: 'rea-mcp' }),
          pluginInfo('include:mcp-gitnexus', '@deepseek-ai/dsh-mcp-client', { patchId: 'mcp-gitnexus' }),
          pluginInfo('include:mcp-superting', '@deepseek-ai/dsh-mcp-client', {
            patchId: 'mcp-superting',
            enabled: false,
          }),
          pluginInfo('include:mcp-future', '@deepseek-ai/dsh-mcp-client', { patchId: 'mcp-future' }),
          pluginInfo('include:mcp-switch', '@local/dsh-mcp-switch', { patchId: 'mcp-switch' }),
          pluginInfo('include:tool-bash', '@deepseek-ai/dsh-tool-bash', { patchId: 'tool-bash' }),
          pluginInfo('include:locked', '@deepseek-ai/dsh-mcp-client', {
            patchId: 'locked-mcp',
            readOnlyReason: 'management-required',
          }),
        ],
      }),
    },
  })

  await store.load()
  const state = store.getSnapshot()
  assert.equal(state.status, 'ready')
  assert.equal(state.error, '')
  assert.deepEqual(
    state.servers.map((entry) => entry.name),
    ['rea', 'gitnexus', 'superting', 'future', 'locked'],
  )
  assert.deepEqual(state.servers.map((entry) => entry.enabled), [true, true, false, true, true])
  assert.deepEqual(state.servers.map((entry) => entry.locked), [false, false, false, false, true])
  assert.match(state.servers[1].desc, /代码知识图谱/)
})

test('a toggle reports the Host outcome and re-reads the Host', async () => {
  const calls = []
  let enabled = true
  const { store } = await mount({
    pluginManager: {
      listPlugins: async () => ({
        ok: true,
        value: [pluginInfo('include:rea-mcp', MCP, { patchId: 'rea-mcp', enabled })],
      }),
      setPluginEnabled: async (entryId, next) => {
        calls.push([entryId, next])
        enabled = next
        return { ok: true, value: { application: 'applied' } }
      },
    },
  })

  await store.load()
  assert.equal(store.getSnapshot().servers[0].enabled, true)

  await store.toggle('include:rea-mcp', false)
  const state = store.getSnapshot()
  assert.deepEqual(calls, [['include:rea-mcp', false]])
  assert.equal(state.busy, '')
  assert.equal(state.notice, 'applied')
  assert.equal(state.error, '')
  assert.equal(state.servers[0].enabled, false)
})

test('a rejected Remote answer and a restart-required outcome both surface', async () => {
  const rejection = await mount({
    pluginManager: {
      listPlugins: async () => ({ ok: true, value: [pluginInfo('include:rea-mcp', MCP, { patchId: 'rea-mcp' })] }),
      setPluginEnabled: async () => ({ ok: false, error: { message: 'manager refused' } }),
    },
  })
  await rejection.store.load()
  await rejection.store.toggle('include:rea-mcp', false)
  assert.equal(rejection.store.getSnapshot().error, 'manager refused')
  assert.equal(rejection.store.getSnapshot().notice, 'failed')
  assert.equal(rejection.store.getSnapshot().busy, '')

  const deferred = await mount({
    pluginManager: {
      listPlugins: async () => ({ ok: true, value: [pluginInfo('include:rea-mcp', MCP, { patchId: 'rea-mcp' })] }),
      setPluginEnabled: async () => ({ ok: true, value: { application: 'restart-required' } }),
    },
  })
  await deferred.store.load()
  await deferred.store.toggle('include:rea-mcp', false)
  assert.equal(deferred.store.getSnapshot().notice, 'restartRequired')
  assert.equal(deferred.store.getSnapshot().error, '')

  const thrown = await mount({
    pluginManager: {
      listPlugins: async () => ({ ok: true, value: [] }),
      setPluginEnabled: async () => {
        throw new Error('transport down')
      },
    },
  })
  await thrown.store.load()
  await thrown.store.toggle('include:rea-mcp', false)
  assert.equal(thrown.store.getSnapshot().error, 'transport down')
})

test('a failed listing keeps the page in its error state', async () => {
  const { store } = await mount({
    pluginManager: {
      listPlugins: async () => ({ ok: false, error: 'no profile management' }),
    },
  })
  await store.load()
  assert.equal(store.getSnapshot().status, 'error')
  assert.equal(store.getSnapshot().error, 'no profile management')
})

test('the page registers its cleanup and follows the Host change events', async () => {
  const { events } = await mount({
    pluginManager: { listPlugins: async () => ({ ok: true, value: [] }) },
  })
  const labels = events.map((event) => event.label).filter(Boolean)
  assert.ok(labels.includes('mcp-switch: dictionaries'))
  assert.ok(labels.includes('mcp-switch: store'))
  assert.ok(labels.includes('mcp-switch: host invalidations'))
})

/** Text content of a fake React element tree, rendering function components. */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') {
      return textOf(node.type({ ...node.props, children: node.children }))
    }
    return textOf(node.children)
  }
  return ''
}

/** Answer the preview route with a fixed payload; returns the fetch calls. */
function stubPreview(payload, status = 200) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push([String(url), init])
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    }
  }
  return calls
}

/** Minimal localStorage stand-in. */
function stubStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  }
}

/** Remove the browser globals a test installed. */
function clearBrowserStubs(saved) {
  if (saved.fetch === undefined) delete globalThis.fetch
  else globalThis.fetch = saved.fetch
  if (saved.localStorage === undefined) delete globalThis.localStorage
  else globalThis.localStorage = saved.localStorage
}

/** The preview payload one enabled server would answer with. */
function supertingPreview() {
  return {
    ok: true,
    route: '/api/mcp-switch/servers',
    servers: [
      {
        entryId: 'include:mcp-superting',
        serverName: 'superting',
        transport: 'streamable-http',
        enabled: true,
        tools: [
          {
            name: 'list_notes',
            description: 'List notes',
            parameters: [{ name: 'limit', required: false }],
          },
          {
            name: 'search_notes',
            description: 'Search notes by keyword',
            parameters: [],
          },
        ],
      },
    ],
  }
}

test('the preview reads each server tool list from the Host route', async () => {
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
  try {
    stubStorage()
    const calls = stubPreview(supertingPreview())
    const { store, Component } = await mount({
      pluginManager: {
        listPlugins: async () => ({
          ok: true,
          value: [
            pluginInfo('include:mcp-superting', MCP, {
              patchId: 'mcp-superting',
            }),
          ],
        }),
      },
    })
    await store.load()
    await store.loadPreview()

    const state = store.getSnapshot()
    assert.equal(state.previewStatus, 'ready')
    assert.equal(state.previewError, '')
    assert.equal(calls[0][0], '/api/mcp-switch/servers')
    assert.equal(calls[0][1].credentials, 'same-origin')
    assert.equal(state.preview['include:mcp-superting'].tools.length, 2)
    assert.equal(state.preview['include:mcp-superting'].tools[1].name, 'search_notes')

    // The toast-free summary is visible without expanding the row.
    const page = textOf(Component({ t: (key) => key, store }))
    assert.match(page, /showTools · 2/)

    // The last live snapshot is persisted for the next page load.
    const cached = JSON.parse(globalThis.localStorage.getItem('dsh.mcp-switch.preview.v1'))
    assert.deepEqual(
      cached['include:mcp-superting'].tools.map((tool) => tool.name),
      ['list_notes', 'search_notes'],
    )
  } finally {
    clearBrowserStubs(saved)
  }
})

test('a disabled server shows the cached snapshot with its age label', async () => {
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
  try {
    stubStorage({
      'dsh.mcp-switch.preview.v1': JSON.stringify({
        'include:mcp-superting': {
          serverName: 'superting',
          tools: [{ name: 'list_notes', description: 'List notes', parameters: [] }],
          asOf: 1700000000000,
        },
      }),
    })
    stubPreview({ ok: false, error: 'forbidden: loopback-only' }, 403)
    const { store, Component } = await mount({
      pluginManager: {
        listPlugins: async () => ({
          ok: true,
          value: [
            pluginInfo('include:mcp-superting', MCP, {
              patchId: 'mcp-superting',
              enabled: false,
            }),
          ],
        }),
      },
    })
    await store.load()
    await store.loadPreview()

    assert.equal(store.getSnapshot().previewStatus, 'unavailable')
    const page = textOf(Component({ t: (key) => key, store }))
    assert.match(page, /showTools · 1 · cachedNote/)
    assert.match(page, /previewUnavailable/)
  } finally {
    clearBrowserStubs(saved)
  }
})

test('an unreachable preview route never disables the switches', async () => {
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
  try {
    stubStorage()
    stubPreview({ ok: false }, 401)
    let enabled = false
    const { store } = await mount({
      pluginManager: {
        listPlugins: async () => ({
          ok: true,
          value: [
            pluginInfo('include:rea-mcp', MCP, { patchId: 'rea-mcp', enabled }),
          ],
        }),
        setPluginEnabled: async (entryId, next) => {
          enabled = next
          return { ok: true, value: { application: 'applied' } }
        },
      },
    })
    await store.load()
    await store.loadPreview()
    assert.equal(store.getSnapshot().previewStatus, 'unavailable')
    assert.match(store.getSnapshot().previewError, /401/)

    await store.toggle('include:rea-mcp', true)
    const state = store.getSnapshot()
    assert.equal(state.notice, 'applied')
    assert.equal(state.error, '')
    assert.equal(state.servers[0].enabled, true)
  } finally {
    clearBrowserStubs(saved)
  }
})

/** Poll until a predicate holds (the page's auto-probe runs asynchronously). */
async function waitFor(predicate, timeout = 3000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for ' + predicate)
}

/** Answer the preview route and the probe route with fixed payloads. */
function stubPreviewAndProbe({ servers, probe }) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    calls.push([target, method])
    if (target.endsWith('/api/mcp-switch/servers')) {
      const payload = { ok: true, servers }
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
    }
    if (target.endsWith('/api/mcp-switch/probe')) {
      const payload =
        probe.error !== undefined
          ? { ok: false, error: probe.error }
          : { ok: true, source: 'probe', probe: probe.probe }
      return {
        ok: probe.error === undefined,
        status: probe.error === undefined ? 200 : 502,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      }
    }
    throw new Error('unexpected fetch ' + target)
  }
  return calls
}

test('a server that was never enabled is probed and previewed before the switch', async () => {
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
  try {
    stubStorage()
    const calls = stubPreviewAndProbe({
      servers: [
        {
          entryId: 'include:mcp-fixture',
          serverName: 'fixture',
          transport: 'stdio',
          enabled: false,
          tools: [],
        },
      ],
      probe: {
        probe: {
          tools: [{ name: 'alpha', description: 'First fixture tool', parameters: [] }],
          probedAt: 1700000000000,
          serverInfo: { name: 'fixture-stdio', version: '1.2.3' },
          protocolVersion: '2025-06-18',
        },
      },
    })
    const { store, Component } = await mount({
      pluginManager: {
        listPlugins: async () => ({
          ok: true,
          value: [pluginInfo('include:mcp-fixture', MCP, { patchId: 'mcp-fixture', enabled: false })],
        }),
      },
    })
    await store.load()
    await store.loadPreview()
    await store.autoProbe()
    await waitFor(() => store.getSnapshot().probes['include:mcp-fixture']?.status === 'ready')

    const page = textOf(Component({ t: (key) => key, store }))
    assert.match(page, /showTools · 1/)
    assert.match(page, /probedAt/)
    assert.ok(calls.some(([, method]) => method === 'POST'), 'the page must probe without enabling the server')
    assert.equal(store.getSnapshot().servers[0].enabled, false)
  } finally {
    clearBrowserStubs(saved)
  }
})

test('a failed probe surfaces its reason and offers a retry', async () => {
  const saved = { fetch: globalThis.fetch, localStorage: globalThis.localStorage }
  try {
    stubStorage()
    stubPreviewAndProbe({
      servers: [
        {
          entryId: 'include:mcp-fixture',
          serverName: 'fixture',
          transport: 'stdio',
          enabled: false,
          tools: [],
        },
      ],
      probe: { error: 'probe: could not start server: ENOENT' },
    })
    const { store, Component } = await mount({
      pluginManager: {
        listPlugins: async () => ({
          ok: true,
          value: [pluginInfo('include:mcp-fixture', MCP, { patchId: 'mcp-fixture', enabled: false })],
        }),
      },
    })
    await store.load()
    await store.loadPreview()
    await store.probe('include:mcp-fixture', true)
    await waitFor(() => store.getSnapshot().probes['include:mcp-fixture']?.status === 'error')

    const page = textOf(Component({ t: (key) => key, store }))
    assert.match(page, /probeFailed/)
    assert.match(page, /ENOENT/)
    assert.match(page, /reread/)
    // The switch itself stays usable.
    assert.equal(store.getSnapshot().servers[0].locked, false)
  } finally {
    clearBrowserStubs(saved)
  }
})
