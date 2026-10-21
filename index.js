/**
 * Host half of @local/dsh-mcp-switch.
 *
 * The Settings page owns switching (it calls the existing `pluginManager`
 * Remote). This half adds one thing the browser cannot learn by itself: the
 * tools each MCP server currently registers, so the page can preview what a
 * server offers before the user toggles it.
 *
 * It contributes one read-only, loopback-only HTTP route on the Host's own
 * web server (`/api/mcp-switch/servers`). Data comes from two existing Host
 * services and nothing is duplicated:
 *
 *   - `ctx.loader` tells which Loader entries are `@deepseek-ai/dsh-mcp-client`
 *     rows and what their resolved `serverName` / `transport` config is.
 *   - `ctx.tools.schemas()` is the live model-facing tool registry; MCP tools
 *     are registered under `mcp__<serverName>__<rawName>`.
 *
 * The route never returns secrets: `env`, `headers`, `args`, `cwd` and the URL
 * of a server stay in the profile. Only the server name, the transport kind,
 * the tool names, their descriptions and parameter names cross the wire.
 *
 * The switch is not required for a preview: the MCP server exists on its own,
 * so `POST /api/mcp-switch/probe` connects to it directly (stdio spawn or
 * Streamable HTTP), calls `tools/list`, and caches the answer on disk under
 * `$DSH_HOME/cache/mcp-switch/probe.json`. The cache is keyed by a fingerprint
 * of the resolved server config, so it is reused until the config changes or
 * the user asks for a refresh. An in-memory "last seen" cache additionally
 * keeps a disabled server's list readable between the toggle and the next
 * probe.
 *
 * Zero dependencies, no build step, plain JavaScript.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { configFingerprint, probeServer } from './probe.js'

/** The one Loader module that carries MCP server rows. */
const MCP_MODULE = '@deepseek-ai/dsh-mcp-client'

/** Public route path. The Client half fetches exactly this string. */
const ROUTE = '/api/mcp-switch/servers'

/** Public probe route: connect to one configured server and read its tools. */
const PROBE_ROUTE = '/api/mcp-switch/probe'

/** The naming contract MCP tools are registered under (`mcp__<server>__<tool>`). */
const TOOL_PREFIX = 'mcp__'

/** Probe cache shape version; a bump discards older files. */
const PROBE_CACHE_VERSION = 1

/** Request body ceiling for the probe route. */
const MAX_PROBE_BODY_BYTES = 4096

/** Preview payload bounds: a settings page, not a dump of every schema. */
const MAX_DESCRIPTION_CHARS = 1000
const MAX_PARAMETERS = 16

/**
 * Register the preview route, plus the snapshot cache that keeps a disabled
 * server's last tool list visible.
 * @param {object} ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  // webServer: claim the routes. tools: read the live registry. Either missing
  // (headless composition) leaves this half inert; the Settings page itself
  // still switches servers through the pluginManager Remote.
  ctx.inject(['webServer', 'tools'], (inner) => {
    /** entryId -> { tools, asOf, live } — survives a toggle within one Host run. */
    const lastSeen = new Map()
    /** entryId -> { fingerprint, tools, probedAt, protocolVersion, serverInfo } on disk. */
    const probeCache = readProbeCache()
    /** entryId -> in-flight probe promise, so a double click spawns once. */
    const inflight = new Map()

    inner.effect(() => {
      const disposers = [
        inner.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: (request, response) => {
            handlePreview(inner, lastSeen, probeCache, request, response)
          },
        }),
        inner.webServer.register({
          kind: 'exact',
          path: PROBE_ROUTE,
          handler: (request, response) => {
            void handleProbe(inner, probeCache, inflight, request, response)
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'mcp-switch: MCP tool preview routes')

    // Keep the cache warm even while no Settings page is open: a server that
    // connects (or re-syncs its tools) leaves a snapshot behind, so toggling it
    // off later still shows what it used to provide.
    inner.effect(() => {
      const remember = () => {
        try {
          collectServers(inner, lastSeen, probeCache)
        } catch {
          // A teardown race must never break plugin activation or an event.
        }
      }
      const dispose = inner.on('tools/change', remember)
      remember()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'mcp-switch: MCP tool snapshot cache')
  })
}

/**
 * Answer one preview request. Read-only: live registry + persisted probe cache.
 * @param {object} ctx - context carrying `webServer`, `tools` and `loader`.
 * @param {Map<string, object>} lastSeen - the in-memory snapshot cache.
 * @param {Record<string, object>} probeCache - the persisted probe cache.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @param {import('node:http').ServerResponse} response - the HTTP response.
 */
function handlePreview(ctx, lastSeen, probeCache, request, response) {
  if (request.method !== 'GET') {
    writeJson(response, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  try {
    const servers = collectServers(ctx, lastSeen, probeCache)
    writeJson(response, 200, { ok: true, route: ROUTE, asOf: Date.now(), servers })
  } catch (error) {
    writeJson(response, 500, { ok: false, error: messageOf(error) })
  }
}

/**
 * Probe one configured MCP server, independent of its Loader switch.
 *
 * The body is `{ entryId, force? }`. An unchanged config and an existing cache
 * answer from disk; otherwise the Host connects to the server, reads
 * `tools/list`, stores the result, and answers with it. Concurrent probes of
 * one row share a single connection.
 * @param {object} ctx - context carrying `webServer`, `tools` and `loader`.
 * @param {Record<string, object>} probeCache - the persisted probe cache.
 * @param {Map<string, Promise<object>>} inflight - per-entry probe promises.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @param {import('node:http').ServerResponse} response - the HTTP response.
 */
async function handleProbe(ctx, probeCache, inflight, request, response) {
  if (request.method !== 'POST') {
    writeJson(response, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (!isLoopbackRequest(request)) {
    writeJson(response, 403, { ok: false, error: 'forbidden: loopback-only' })
    return
  }
  let body
  try {
    body = await readJsonBody(request)
  } catch (error) {
    writeJson(response, 400, { ok: false, error: messageOf(error) })
    return
  }
  const entryId = typeof body?.entryId === 'string' ? body.entryId : ''
  if (entryId === '') {
    writeJson(response, 400, { ok: false, error: 'entryId is required' })
    return
  }
  let entry
  try {
    entry = findMcpEntry(ctx, entryId)
  } catch (error) {
    writeJson(response, 500, { ok: false, error: messageOf(error) })
    return
  }
  if (entry === void 0) {
    writeJson(response, 404, { ok: false, error: 'unknown MCP row' })
    return
  }
  const config = resolveServerConfig(entry)
  if (!isRecord(config)) {
    writeJson(response, 502, { ok: false, error: 'resolved server config is unavailable' })
    return
  }
  const fingerprint = configFingerprint(config)
  const cached = probeCache[entryId]
  if (body?.force !== true && cached !== void 0 && cached.fingerprint === fingerprint && cached.tools.length > 0) {
    writeJson(response, 200, { ok: true, source: 'cache', probe: publicProbe(cached) })
    return
  }
  let task = inflight.get(entryId)
  if (task === void 0) {
    task = probeServer(config).finally(() => inflight.delete(entryId))
    inflight.set(entryId, task)
  }
  try {
    const result = await task
    const probe = {
      fingerprint,
      serverName: typeof config.serverName === 'string' ? config.serverName : '',
      protocolVersion: result.protocolVersion,
      serverInfo: result.serverInfo,
      tools: result.tools,
      probedAt: Date.now(),
    }
    probeCache[entryId] = probe
    saveProbeCache(probeCache)
    writeJson(response, 200, { ok: true, source: 'probe', probe: publicProbe(probe) })
  } catch (error) {
    writeJson(response, 502, { ok: false, error: messageOf(error) })
  }
}

/**
 * Find one Loader entry by id that names the MCP client module.
 * @param {object} ctx - context carrying `loader`.
 * @param {string} entryId - the Loader entry id from the page.
 * @returns {object|undefined} the entry.
 */
function findMcpEntry(ctx, entryId) {
  const loader = ctx.get('loader')
  if (loader === void 0) throw new Error('loader service is unavailable')
  for (const entry of loader.entries()) {
    if (entry.id === entryId && entry.options?.name === MCP_MODULE) return entry
  }
  return void 0
}

/**
 * Resolve one row's effective MCP client config. A running row exposes its
 * resolved config on the Fiber; a disabled row is interpolated from the raw
 * patch, including YAML `!!js` expressions (e.g. a token from `process.env`).
 * @param {object} entry - a Loader entry.
 * @returns {object|undefined} the config to connect with.
 */
function resolveServerConfig(entry) {
  const running = entry.fiber?.config
  if (isRecord(running)) return running
  const raw = entry.options?.config
  if (raw === void 0) return void 0
  return interpolateConfig(entry, raw)
}

/** Recursively replace `!!js` expression nodes using the Loader's evaluator. */
function interpolateConfig(entry, value) {
  if (isJsExpr(value)) {
    try {
      return typeof entry.evaluate === 'function' ? entry.evaluate(value.__jsExpr) : void 0
    } catch {
      return void 0
    }
  }
  if (Array.isArray(value)) return value.map((item) => interpolateConfig(entry, item))
  if (isRecord(value)) {
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = interpolateConfig(entry, item)
    return output
  }
  return value
}

/** Whether a value is a serialized Loader `!!js` expression. */
function isJsExpr(value) {
  return isRecord(value) && Object.hasOwn(value, '__jsExpr')
}

/**
 * Read the current MCP rows, their live tools, and the persisted probe cache.
 * Live tool lists are also written back to the probe cache, so enabling a
 * server once populates the preview for later (including after a restart).
 * @param {object} ctx - context carrying `loader` and `tools`.
 * @param {Map<string, object>} lastSeen - the in-memory snapshot cache.
 * @param {Record<string, object>} probeCache - the persisted probe cache.
 * @returns {Array<object>} one public row per MCP Loader entry.
 */
function collectServers(ctx, lastSeen, probeCache) {
  const loader = ctx.get('loader')
  if (loader === void 0) throw new Error('loader service is unavailable')
  const schemas = readSchemas(ctx)
  const servers = []
  let cacheChanged = false
  for (const entry of loader.entries()) {
    if (entry.options?.name !== MCP_MODULE) continue
    const config = isRecord(entry.options.config) ? entry.options.config : {}
    const serverName = typeof config.serverName === 'string' ? config.serverName : ''
    const tools = serverName === '' ? [] : readTools(schemas, serverName)
    // Toggling a server off unregisters its tools one by one, and each
    // unregister emits `tools/change`. Remembering every intermediate state
    // would leave the cache at one tool, so a shrinking live set only marks the
    // generation as over; the snapshot is replaced when the next generation
    // starts (0 -> live) or when the live set grows within one generation.
    const seen = lastSeen.get(entry.id)
    if (tools.length > 0) {
      const freshGeneration = seen === void 0 || seen.live !== true
      if (freshGeneration || tools.length >= seen.tools.length) {
        lastSeen.set(entry.id, { tools, asOf: Date.now(), live: true })
      } else {
        seen.live = true
      }
    } else if (seen !== void 0) {
      seen.live = false
    }
    const cached = tools.length > 0 ? void 0 : lastSeen.get(entry.id)
    // A live list is authoritative: fold it into the persisted cache so the
    // page keeps a preview after the row is disabled or the Host restarts.
    // While the row is being torn down the registry shrinks one tool at a
    // time, so only an enabled row may write, and only when the new list is a
    // fresh config or at least as large as the cached one.
    if (tools.length > 0) {
      const fingerprint = configFingerprint(isRecord(config) ? config : {})
      const stored = probeCache[entry.id]
      const sameConfig = stored !== void 0 && stored.fingerprint === fingerprint
      if (!entry.disabled && (stored === void 0 || !sameConfig || tools.length >= stored.tools.length)) {
        const signature = tools.map((tool) => tool.name).join('\u0000')
        const storedSignature = stored === void 0 ? '' : stored.tools.map((tool) => tool.name).join('\u0000')
        if (!sameConfig || storedSignature !== signature) {
          probeCache[entry.id] = {
            fingerprint,
            serverName,
            protocolVersion: stored?.protocolVersion ?? '',
            serverInfo: stored?.serverInfo ?? {},
            tools,
            probedAt: Date.now(),
          }
          cacheChanged = true
        }
      }
    }
    const probe = probeCache[entry.id]
    const probeValid =
      probe !== void 0 && probe.tools.length > 0 && probe.fingerprint === configFingerprint(isRecord(config) ? config : {})
    servers.push({
      entryId: entry.id,
      serverName,
      transport: typeof config.transport === 'string' ? config.transport : '',
      enabled: !entry.disabled,
      tools,
      ...(cached === void 0
        ? {}
        : { cached: { tools: cached.tools, asOf: cached.asOf } }),
      ...(probeValid === true ? { probe: publicProbe(probe) } : {}),
    })
  }
  if (cacheChanged) saveProbeCache(probeCache)
  return servers
}

/** The public shape of one cached probe (no config, no secrets). */
function publicProbe(probe) {
  return {
    tools: probe.tools,
    probedAt: probe.probedAt,
    protocolVersion: probe.protocolVersion,
    serverInfo: probe.serverInfo,
  }
}

/** Location of the persisted probe cache. */
function probeCacheFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'cache', 'mcp-switch', 'probe.json')
}

/**
 * Load the persisted probe cache, discarding an unreadable or older file.
 * @returns {Record<string, object>} entryId -> cached probe.
 */
function readProbeCache() {
  try {
    const parsed = JSON.parse(readFileSync(probeCacheFile(), 'utf8'))
    if (!isRecord(parsed) || parsed.version !== PROBE_CACHE_VERSION || !isRecord(parsed.entries)) return {}
    const entries = {}
    for (const [entryId, value] of Object.entries(parsed.entries)) {
      if (!isRecord(value) || !Array.isArray(value.tools)) continue
      entries[entryId] = value
    }
    return entries
  } catch {
    return {}
  }
}

/**
 * Persist the probe cache atomically, newest entries kept. A failure is
 * silent: the cache only saves work, it never gates the preview.
 * @param {Record<string, object>} probeCache - entryId -> cached probe.
 */
function saveProbeCache(probeCache) {
  try {
    const file = probeCacheFile()
    mkdirSync(dirname(file), { recursive: true })
    const entries = Object.entries(probeCache)
      .sort((left, right) => (right[1].probedAt ?? 0) - (left[1].probedAt ?? 0))
      .slice(0, 32)
    const payload = JSON.stringify({ version: PROBE_CACHE_VERSION, entries: Object.fromEntries(entries) })
    const temporary = file + '.tmp'
    writeFileSync(temporary, payload)
    renameSync(temporary, file)
  } catch {
    // Best effort.
  }
}

/**
 * Read one bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @returns {Promise<object>} the parsed body.
 */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_PROBE_BODY_BYTES) {
        reject(new Error('request body is too large'))
        request.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(isRecord(parsed) ? parsed : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })
}

/**
 * The Host tool registry as one global view, defensively narrowed.
 * @param {object} ctx - context carrying `tools`.
 * @returns {Array<object>} visible tool schemas; empty when unavailable.
 */
function readSchemas(ctx) {
  const tools = ctx.get('tools')
  if (tools === void 0 || typeof tools.schemas !== 'function') return []
  const schemas = tools.schemas()
  return Array.isArray(schemas) ? schemas : []
}

/**
 * Project one server's registered tools.
 * @param {Array<object>} schemas - the global tool schemas.
 * @param {string} serverName - the `serverName` from the Loader row's config.
 * @returns {Array<object>} public tool previews, sorted by name.
 */
function readTools(schemas, serverName) {
  const prefix = TOOL_PREFIX + serverName + '__'
  const rows = []
  for (const schema of schemas) {
    if (typeof schema?.name !== 'string' || !schema.name.startsWith(prefix)) continue
    rows.push({
      // The public suffix is the model-facing name minus the server namespace.
      // A raw MCP name that had to be normalized keeps its hash suffix here;
      // the wire never carries the raw name, and parsing it back is forbidden
      // by the MCP client's naming contract.
      name: schema.name.slice(prefix.length) || schema.name,
      publicName: schema.name,
      description: truncate(typeof schema.description === 'string' ? schema.description : ''),
      parameters: readParameters(schema.parameters),
    })
  }
  rows.sort((left, right) => left.name.localeCompare(right.name))
  return rows
}

/**
 * Top-level JSON-Schema parameter names of one tool.
 * @param {unknown} parameters - the tool's parameter schema.
 * @returns {Array<{name: string, required: boolean}>} at most MAX_PARAMETERS entries.
 */
function readParameters(parameters) {
  if (!isRecord(parameters) || !isRecord(parameters.properties)) return []
  const required = new Set(Array.isArray(parameters.required) ? parameters.required : [])
  return Object.keys(parameters.properties)
    .slice(0, MAX_PARAMETERS)
    .map((name) => ({ name, required: required.has(name) }))
}

/**
 * Bound one description for a settings-page preview.
 * @param {string} text - the raw description.
 * @returns {string} the description, truncated when needed.
 */
function truncate(text) {
  const trimmed = text.trim()
  return trimmed.length <= MAX_DESCRIPTION_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_DESCRIPTION_CHARS - 1) + '…'
}

/**
 * Whether a request comes from this machine's own browser page.
 *
 * Mirrors the local-route fence other Host routes use: the socket peer must be
 * loopback, the Host header must name a loopback host, a browser cross-site
 * fetch marker is refused, and a present Origin must match that Host.
 * @param {import('node:http').IncomingMessage} request - the HTTP request.
 * @returns {boolean} true when the request is a same-origin loopback request.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let authority
  try {
    authority = new URL('http://' + host)
  } catch {
    return false
  }
  const hostname = authority.hostname.replace(/^\[|\]$/g, '')
  if (hostname !== 'localhost' && !isLoopbackAddress(hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === void 0) return true
  try {
    return new URL(origin).host === authority.host
  } catch {
    return false
  }
}

/**
 * IPv4 127/8, IPv6 `::1`, and their IPv4-mapped spellings.
 * @param {unknown} address - a socket remote address or URL hostname.
 * @returns {boolean} whether the value names the loopback range.
 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const bare = address.replace(/^\[|\]$/g, '')
  const dotted = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare
  if (dotted.includes('.')) {
    const parts = dotted.split('.')
    return (
      parts.length === 4 &&
      parts[0] === '127' &&
      parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
    )
  }
  return bare === '::1' || bare === '0:0:0:0:0:0:0:1'
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the HTTP response.
 * @param {number} status - status code.
 * @param {object} body - JSON body.
 */
function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

/**
 * Normalize a rejection into readable text.
 * @param {unknown} error - anything thrown.
 * @returns {string} its message.
 */
function messageOf(error) {
  if (error === void 0 || error === null) return ''
  if (typeof error === 'string') return error
  const message = error.message ?? error.code
  return typeof message === 'string' && message !== '' ? message : String(error)
}

/**
 * Plain-object guard.
 * @param {unknown} value - any value.
 * @returns {boolean} true for a non-array object.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
