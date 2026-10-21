/**
 * Minimal, zero-dependency MCP client used only to read one server's tool list.
 *
 * A DSH MCP switch controls whether the Agent-side client plugin runs, but the
 * MCP server itself exists independently: its command or URL is already in the
 * profile. So the preview can connect on its own, ask for `tools/list`, and
 * cache the answer — the switch does not have to be on first.
 *
 * Two transports are implemented, matching the two the MCP client plugin
 * supports:
 *
 *   - `stdio`: spawn `command args…`, speak newline-delimited JSON-RPC on
 *     stdin/stdout (the MCP stdio framing), then shut the child down.
 *   - `streamable-http`: POST JSON-RPC to `url` with the configured headers,
 *     accepting both a JSON response and a single-shot SSE stream.
 *
 * Only the handshake and `tools/list` are implemented. Nothing is written
 * anywhere and no credentials are logged: probe results contain tool metadata
 * only (`name`, `description`, parameter names), never the transport config.
 *
 * Plain JavaScript, Node built-ins only, no build step.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'

/** Protocol revision offered first; a server may negotiate another one. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05']
/** Client identity sent in `initialize`. */
const CLIENT_INFO = { name: 'dsh-mcp-switch-probe', version: '0.3.0' }
/** Default ceiling for one probe (connect + handshake + tools/list). */
export const DEFAULT_PROBE_TIMEOUT_MS = 20000
/** Upper bound for one server's tool list in the preview payload. */
const MAX_TOOLS = 500
/** Upper bound for one tool description in the preview payload. */
const MAX_DESCRIPTION_CHARS = 1000
/** Upper bound for top-level parameter names per tool. */
const MAX_PARAMETERS = 16
/** Pages fetched at most when a server paginates `tools/list`. */
const MAX_TOOL_PAGES = 20
/** Keep this much server stderr for diagnostics. */
const MAX_STDERR_CHARS = 4000

/**
 * Probe one MCP server and return its tools.
 * @param {object} config - resolved MCP client config (`transport`, `command`,
 *   `args`, `env`, `cwd`, `url`, `headers`).
 * @param {{ timeoutMs?: number }} [options] - timeout override.
 * @returns {Promise<{protocolVersion: string, serverInfo: object, tools: Array<object>}>}
 */
export async function probeServer(config, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_PROBE_TIMEOUT_MS
  if (!isRecord(config)) throw new Error('probe: resolved server config is unavailable')
  let lastError
  for (const protocolVersion of PROTOCOL_VERSIONS) {
    try {
      const result = config.transport === 'stdio'
        ? await probeStdio(config, protocolVersion, timeoutMs)
        : config.transport === 'streamable-http'
          ? await probeHttp(config, protocolVersion, timeoutMs)
          : (() => {
              throw new Error(`probe: unsupported transport ${JSON.stringify(config.transport)}`)
            })()
      return { ...result, tools: result.tools.slice(0, MAX_TOOLS) }
    } catch (error) {
      lastError = error
      // A server that rejects the offered revision may accept the older one;
      // anything else (auth, spawn, timeout) is retried for the same reason a
      // second connect is cheap, then reported with the last failure.
    }
  }
  throw lastError
}

/**
 * A stable fingerprint of the settings that decide which server answers and
 * what it exposes. The cache is reused while the fingerprint matches; any
 * config edit (including a rotated token) invalidates it.
 * @param {object} config - resolved MCP client config.
 * @returns {string} SHA-256 hex digest.
 */
export function configFingerprint(config) {
  const relevant = isRecord(config)
    ? {
        transport: config.transport,
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        url: config.url,
        headers: config.headers,
      }
    : {}
  return createHash('sha256').update(stableStringify(relevant)).digest('hex')
}

/**
 * Project one raw MCP tool into the preview payload.
 * @param {unknown} tool - an entry of `tools/list`.
 * @returns {object|undefined} the public tool row.
 */
function projectTool(tool) {
  if (!isRecord(tool) || typeof tool.name !== 'string' || tool.name === '') return void 0
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {}
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return {
    name: tool.name,
    description: truncate(typeof tool.description === 'string' ? tool.description : ''),
    parameters: Object.keys(properties)
      .slice(0, MAX_PARAMETERS)
      .map((name) => ({ name, required: required.has(name) })),
  }
}

/** One newline-delimited JSON-RPC round trip over a spawned stdio server. */
async function probeStdio(config, protocolVersion, timeoutMs) {
  if (typeof config.command !== 'string' || config.command === '') {
    throw new Error('probe: stdio config has no command')
  }
  const child = spawn(config.command, Array.isArray(config.args) ? config.args : [], {
    cwd: typeof config.cwd === 'string' ? config.cwd : void 0,
    env: { ...process.env, ...(isRecord(config.env) ? config.env : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  let stderr = ''
  let finished = false
  const settleAll = (error) => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  const cleanup = () => {
    if (finished) return
    finished = true
    try {
      child.stdin.end()
    } catch {
      // The pipe may already be gone.
    }
    child.kill('SIGTERM')
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        // Already exited.
      }
    }, 500)
    if (typeof force.unref === 'function') force.unref()
  }
  child.once('error', (error) => settleAll(new Error(`probe: could not start server: ${String(error)}`)))
  child.once('exit', (code, signal) => {
    settleAll(new Error(`probe: server exited before replying (code=${code}, signal=${signal})${stderrTail(stderr)}`))
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
    if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS)
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
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
      if (!isRecord(message) || message.id === void 0 || !pending.has(message.id)) continue
      const entry = pending.get(message.id)
      pending.delete(message.id)
      if (message.error !== void 0) entry.reject(new Error(jsonRpcErrorText(message.error)))
      else entry.resolve(message.result)
    }
  })
  const send = (message) => {
    child.stdin.write(JSON.stringify(message) + '\n')
  }
  const notify = (method, params) => {
    send({ jsonrpc: '2.0', method, ...(params === void 0 ? {} : { params }) })
  }
  const request = (method, params) => {
    const id = nextId++
    return withTimeout(
      new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ jsonrpc: '2.0', id, method, params })
      }),
      timeoutMs,
      `probe: ${method} timed out after ${timeoutMs}ms${stderrTail(stderr)}`,
    )
  }
  try {
    const init = await request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    notify('notifications/initialized')
    const tools = await listAllTools(request)
    return {
      protocolVersion: typeof init?.protocolVersion === 'string' ? init.protocolVersion : protocolVersion,
      serverInfo: isRecord(init?.serverInfo) ? init.serverInfo : {},
      tools,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(message.includes('probe:') ? message : `${message}${stderrTail(stderr)}`)
  } finally {
    cleanup()
  }
}

/** One newline-delimited JSON-RPC round trip over Streamable HTTP. */
async function probeHttp(config, protocolVersion, timeoutMs) {
  if (typeof config.url !== 'string' || config.url === '') {
    throw new Error('probe: streamable-http config has no url')
  }
  const baseHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(isRecord(config.headers) ? config.headers : {}),
  }
  let session
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const post = async (message) => {
    const headers = { ...baseHeaders }
    if (session !== void 0) headers['mcp-session-id'] = session
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: controller.signal,
    })
    const nextSession = response.headers.get('mcp-session-id')
    if (typeof nextSession === 'string' && nextSession !== '') session = nextSession
    return response
  }
  const request = async (id, method, params) => {
    try {
      const response = await withTimeout(post({ jsonrpc: '2.0', id, method, params }), timeoutMs, `probe: ${method} timed out after ${timeoutMs}ms`)
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`probe: ${method} failed with HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 200)}`}`)
      }
      return await readJsonRpcResult(response, id)
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`probe: ${method} timed out after ${timeoutMs}ms`)
      throw error
    }
  }
  try {
    const init = await request(1, 'initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => void 0)
    let nextId = 2
    let cursor
    const tools = []
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await request(nextId++, 'tools/list', cursor === void 0 ? {} : { cursor })
      for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
        const projected = projectTool(tool)
        if (projected !== void 0) tools.push(projected)
      }
      cursor = result?.nextCursor
      if (typeof cursor !== 'string' || cursor === '') break
    }
    return {
      protocolVersion: typeof init?.protocolVersion === 'string' ? init.protocolVersion : protocolVersion,
      serverInfo: isRecord(init?.serverInfo) ? init.serverInfo : {},
      tools,
    }
  } finally {
    clearTimeout(timer)
    // The transport may keep a session open; closing it is advisory.
    if (session !== void 0) {
      fetch(config.url, {
        method: 'DELETE',
        headers: { ...baseHeaders, 'mcp-session-id': session },
        signal: AbortSignal.timeout(2000),
      }).catch(() => void 0)
    }
  }
}

/** All pages of `tools/list`, projected into preview rows. */
async function listAllTools(request) {
  const tools = []
  let cursor
  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const result = await request('tools/list', cursor === undefined ? {} : { cursor })
    for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
      const projected = projectTool(tool)
      if (projected !== void 0) tools.push(projected)
    }
    cursor = result?.nextCursor
    if (typeof cursor !== 'string' || cursor === '') break
  }
  return tools
}

/**
 * Read one JSON-RPC result from a Streamable HTTP response. Supports the JSON
 * response mode and the SSE mode (single or multiple `data:` events; the
 * request's own id selects its reply).
 * @param {Response} response - the HTTP response.
 * @param {number|string} id - the request id to await.
 * @returns {Promise<unknown>} the JSON-RPC result.
 */
async function readJsonRpcResult(response, id) {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    if (response.body === null) throw new Error('probe: empty SSE response')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice('data:'.length).trim()
          if (payload === '') continue
          let message
          try {
            message = JSON.parse(payload)
          } catch {
            continue
          }
          if (!isRecord(message) || message.id !== id) continue
          if (message.error !== void 0) throw new Error(jsonRpcErrorText(message.error))
          return message.result
        }
      }
    } finally {
      reader.cancel().catch(() => void 0)
    }
    throw new Error('probe: SSE stream ended without a response')
  }
  const text = await response.text()
  if (text.trim() === '') return void 0
  let message
  try {
    message = JSON.parse(text)
  } catch {
    throw new Error(`probe: invalid JSON response: ${text.slice(0, 120)}`)
  }
  if (Array.isArray(message)) {
    const match = message.find((item) => isRecord(item) && item.id === id)
    if (match === void 0) return void 0
    if (match.error !== void 0) throw new Error(jsonRpcErrorText(match.error))
    return match.result
  }
  if (!isRecord(message)) throw new Error('probe: invalid JSON-RPC response')
  if (message.id !== id) return void 0
  if (message.error !== void 0) throw new Error(jsonRpcErrorText(message.error))
  return message.result
}

/** Human-readable JSON-RPC error, with its data when the server supplied one. */
function jsonRpcErrorText(error) {
  if (!isRecord(error)) return `probe: JSON-RPC error ${String(error)}`
  const code = error.code === void 0 ? '' : ` (${String(error.code)})`
  const message = typeof error.message === 'string' ? error.message : JSON.stringify(error)
  return `probe: server error${code}: ${message}`
}

/** Bound one description for the preview payload. */
function truncate(text) {
  const trimmed = text.trim()
  return trimmed.length <= MAX_DESCRIPTION_CHARS
    ? trimmed
    : trimmed.slice(0, MAX_DESCRIPTION_CHARS - 1) + '…'
}

/** The tail of a server's stderr, prefixed for an error message. */
function stderrTail(stderr) {
  const trimmed = stderr.trim()
  if (trimmed === '') return ''
  return ` — server stderr: ${trimmed.slice(-1200)}`
}

/** Race a promise against a labeled timeout. */
function withTimeout(promise, timeoutMs, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Deterministic JSON: object keys sorted at every depth. */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Plain-object guard. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
