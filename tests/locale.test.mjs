/**
 * 展示元信息与打包边界的回归测试。
 *
 * DSH 0.2.2 的语言包加载器（`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta`）会：
 *   1. 扫描 `locale/` 目录下的**每一个** `*.json`，文件名必须是合法语言 id
 *      （`/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/`），否则整个包的元信息读取直接抛错；
 *   2. 只读 JSON 里的 `meta.title` / `meta.description`，平铺的 `title` / `description`
 *      会被忽略 → 插件管理器里标题回退成包名 `@local/dsh-mcp-switch`。
 *
 * 踩坑场景：macOS 把目录整体拷到非 HFS 文件系统（SMB / 网络盘 / tar）时，每个文件旁边
 * 会多出 AppleDouble 旁注文件 `._en.json`（不是 JSON，是 "Mac OS X" 魔数的二进制），
 * 它既匹配第 1 条的扫描范围，文件名又不是合法语言 id → 整个包显示「包元信息错误」。
 * 所以这里守两件事：locale 目录里不能有多余文件、每个语言包必须带 `meta` 结构。
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = fileURLToPath(new URL('..', import.meta.url))
const localeDir = join(root, 'locale')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** DSH 语言包加载器认可的语言 id（与 dsh-app-boot 的 LANGUAGE_ID 一致）。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** 本插件提供的语言包；新增语言时同步这里和 package.json 的 files。 */
const SUPPORTED_LOCALES = ['en.json', 'zh.json']

/** 仓库里不允许出现的 macOS 旁注文件前缀（AppleDouble）。 */
function appleDoubleFiles(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) appleDoubleFiles(path, found)
    else if (entry.name.startsWith('._')) found.push(path)
  }
  return found
}

test('locale 目录只有受支持的语言包，文件名都是合法语言 id', () => {
  const entries = readdirSync(localeDir)
  const jsonFiles = entries.filter((name) => name.endsWith('.json'))
  assert.deepEqual([...jsonFiles].sort(), [...SUPPORTED_LOCALES].sort())
  for (const name of jsonFiles) {
    const language = name.slice(0, -5)
    assert.match(language, LANGUAGE_ID, `${name} 的文件名不是合法语言 id`)
  }
})

test('每个语言包都带 meta.title / meta.description（0.2.2 展示元信息必需）', () => {
  for (const name of SUPPORTED_LOCALES) {
    const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))
    assert.equal(typeof parsed.meta, 'object', `${name} 缺少 meta`)
    assert.equal(typeof parsed.meta.title, 'string')
    assert.notEqual(parsed.meta.title.trim(), '')
    assert.equal(typeof parsed.meta.description, 'string')
    assert.notEqual(parsed.meta.description.trim(), '')
    // 平铺键保留给更早的加载器；新加载器会忽略它们，但不能删掉。
    assert.equal(typeof parsed.title, 'string')
    assert.equal(typeof parsed.description, 'string')
  }
})

test('仓库里没有 AppleDouble 旁注文件（._*）', () => {
  assert.deepEqual(appleDoubleFiles(root), [])
})

test('package.json 的 files 用显式语言包文件名，不给通配留口子', () => {
  const files = pkg.files ?? []
  assert.ok(files.includes('locale/en.json'))
  assert.ok(files.includes('locale/zh.json'))
  for (const entry of files) {
    assert.doesNotMatch(entry, /locale\/.*\*/, `${entry} 用了 locale 通配，垃圾文件会跟着进包`)
  }
})

test('package.json 导出语言包资源（DSH 用 <plugin>/locale/en.json 读展示文案）', () => {
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
})

test('图标在包里且不是软链（DSH 会校验图标必须留在包目录内）', () => {
  const icon = join(root, pkg.icon)
  assert.equal(statSync(icon).isFile(), true)
})
