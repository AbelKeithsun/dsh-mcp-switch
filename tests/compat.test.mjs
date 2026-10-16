/**
 * 兼容声明的回归测试。
 *
 * 这些断言与运行环境无关（不依赖本机装的是哪个 DSH 版本），它们守住的是
 * "声明存在且自洽"：DSH 只读 peerDependencies，漏了这个字段就等于放弃校验。
 * 想校验"本机版本是否实测过"，跑 `npm run compat`。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const script = new URL('../scripts/check-compat.mjs', import.meta.url)

test('声明了 DSH peer 范围（DSH 的兼容校验只读这个字段）', () => {
  const range = pkg.peerDependencies?.['@deepseek-ai/dsh']
  assert.equal(typeof range, 'string')
  assert.notEqual(range.trim(), '')
})

test('dsh.engines.dsh 与 peer 范围一致，仅作展示镜像', () => {
  assert.equal(pkg.dsh.engines.dsh, pkg.peerDependencies['@deepseek-ai/dsh'])
})

test('testedWith 是精确版本的实测清单', () => {
  const tested = pkg.dsh.testedWith
  assert.ok(Array.isArray(tested) && tested.length > 0)
  for (const version of tested) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  }
})

test('peer 标记为 optional，避免包管理器去自动安装运行时', () => {
  assert.equal(pkg.peerDependenciesMeta?.['@deepseek-ai/dsh']?.optional, true)
})

test('check-compat 对已实测版本退出 0，对未实测版本退出 1 并打印复验清单', () => {
  const tested = pkg.dsh.testedWith[0]
  const ok = spawnSync(process.execPath, [script.pathname, tested], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /在实测清单里/)

  const ahead = spawnSync(process.execPath, [script.pathname, '99.0.0-rc.1'], { encoding: 'utf8' })
  assert.equal(ahead.status, 1, ahead.stdout + ahead.stderr)
  assert.match(ahead.stdout, /不在实测清单里/)
  assert.match(ahead.stdout, /复验清单/)
})
