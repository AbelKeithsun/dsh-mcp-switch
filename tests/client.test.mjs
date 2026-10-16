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
