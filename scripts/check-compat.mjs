#!/usr/bin/env node
/**
 * 检查本插件的 DSH 兼容声明与运行中的 DSH 版本是否对得上，并在版本未实测时给出复验清单。
 *
 * 用法：
 *   npm run compat                    # 自动探测运行中的 DSH 版本
 *   npm run compat -- 0.3.0-rc.1      # 指定版本（升级前预演）
 *   DSH_RUNTIME_VERSION=0.3.0-rc.1 npm run compat
 *
 * 背景：DSH 的兼容校验（@deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility）
 * 只读 package.json 的 `peerDependencies` 里 `@deepseek-ai/dsh` 与
 * `@deepseek-ai/dsh-*` 的 semver 范围；`engines` / `dsh.engines` 都不参与校验。
 * 本脚本校验的是"跑过的版本清单"（dsh.testedWith），它比 semver 范围更严格：
 * 范围决定 DSH 会不会拒绝加载，清单决定我们有没有真的验证过。
 *
 * 退出码：0 = 运行版本在实测清单内；1 = 不在，需要复验；2 = 探测不到运行版本。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const peers = pkg.peerDependencies ?? {}
const runtimePeerRange = peers['@deepseek-ai/dsh']
const tested = Array.isArray(pkg.dsh?.testedWith) ? pkg.dsh.testedWith : []
const enginesRange = pkg.dsh?.engines?.dsh
const clientPeers = Object.keys(peers).filter(
  (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
)

/** 运行中的 DSH 版本：命令行参数 → 环境变量 → 运行时清单 → 未知。 */
function resolveRuntime() {
  const argument = process.argv[2]
  if (typeof argument === 'string' && argument.trim() !== '') {
    return { version: argument.trim(), source: '命令行参数' }
  }
  const fromEnv = process.env.DSH_RUNTIME_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { version: fromEnv.trim(), source: 'DSH_RUNTIME_VERSION' }
  }
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'dsh-runtimes')
  if (existsSync(root)) {
    for (const entry of readdirSync(root)) {
      const file = join(root, entry, 'runtime.json')
      if (!existsSync(file)) continue
      let parsed
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      const version = parsed.desktopVersion ?? parsed.dshVersion ?? parsed.runtimeVersion
      if (typeof version === 'string' && version !== '') return { version, source: file }
    }
  }
  return { version: undefined, source: '未找到（可用参数或 DSH_RUNTIME_VERSION 指定）' }
}

/** profile 里已授予的精确版本豁免，直接决定"不兼容还能不能跑"。 */
function readExemptions() {
  const dir = process.env.DSH_PROFILE_DIR
  if (typeof dir !== 'string' || dir === '') return []
  const file = join(dir, 'compatibility.json')
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Object.entries(parsed.exemptions ?? {})
  } catch {
    return []
  }
}

const runtime = resolveRuntime()
const exemptions = readExemptions()
const short = (file) => file.replace(homedir(), '~')

console.log(`插件          ${pkg.name}@${pkg.version}`)
console.log(`运行中的 DSH  ${runtime.version ?? '(未知)'}   ← ${short(runtime.source)}`)
console.log(`peer 声明     ${runtimePeerRange ?? '(未声明，DSH 将跳过兼容校验)'}`)
if (clientPeers.length > 1) console.log(`              其它 peer: ${clientPeers.slice(1).join(', ')}`)
if (enginesRange !== undefined) console.log(`dsh.engines   ${enginesRange}（生态展示用，DSH 不校验）`)
console.log(`实测清单      ${tested.length === 0 ? '(空)' : tested.join(', ')}`)
if (exemptions.length > 0) {
  console.log('已授豁免      ' + exemptions.map(([key, versions]) => `${key} @ ${versions.join('/')}`).join('  '))
}

if (runtime.version === undefined) {
  console.log('\n结果          ? 探测不到运行中的 DSH 版本，无法判断。')
  console.log('              传参重试：npm run compat -- <dsh 版本>')
  process.exit(2)
}

if (tested.includes(runtime.version)) {
  console.log(`\n结果          ✔ ${runtime.version} 在实测清单里，按声明可以直接用。`)
  console.log(`              范围 ${runtimePeerRange ?? '(未声明)'} 由 DSH 在每个 bundle 加载前自行校验。`)
  process.exit(0)
}

console.log(`\n结果          ✘ ${runtime.version} 不在实测清单里 —— 升级后需要复验再放宽声明。`)
console.log(`
复验清单（任一接口变了就要改代码并重新实测）：
  1. 客户端模块格式：window.__ModuleLoader__.load({ id, factory }) 是否仍是浏览器半边的加载约定。
  2. 设置页 slot：cordis_inspect_query（client, provider=Slots, method=listSubTree, input={"root":"settings.section"}）
     是否仍接受注册项 { id, order, label, locale, inject }，以及 settings.section 这个槽位名是否还在。
  3. 宿主 Remote：cordis_inspect_query（client, provider=Service, method=listService）
     里 pluginManager 的 listPlugins / setPluginEnabled 签名，以及返回信封 { ok, value } 是否没变。
  4. 事件名：plugin-manager/changed、connection/reset。
  5. 预览/探测路由：webServer.register({kind:'exact',path,handler})、tools.schemas()、loader.entries()、
     entry.fiber.config 仍可用；GET /api/mcp-switch/servers 返回 200 且 servers[].tools 是数组；
     POST /api/mcp-switch/probe {entryId} 能返回该服务的工具数组（未开启的服务也可以）。
  6. 实测：设置 → MCP 服务，关一个再开回来（或 plugin_manager set_plugin include:<patchId>），
     确认 application=applied，关闭状态下仍能查看工具（探测缓存）。
  7. 全过之后：把 ${runtime.version} 加进 dsh.testedWith、按需调整 peerDependencies、升 version、发 Release；
     未复验又想先跑，用 dsh plugin allow-version 或插件管理器授"精确版本豁免"（记在 $DSH_PROFILE_DIR/compatibility.json）。`)
process.exit(1)
