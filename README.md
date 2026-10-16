# dsh-mcp-switch — Harness 的「MCP 服务」开关页

> GitHub: <https://github.com/AbelKeithsun/dsh-mcp-switch> · MIT

在 DSH Web UI 的 **设置 → MCP 服务** 里逐个启用/停用本 profile 的 MCP 服务器，
运行时热生效，不用重启 Harness。

## 它做什么

- 列出本 profile 里所有 `@deepseek-ai/dsh-mcp-client` 的 Loader 行（当前是 `rea` /
  `gitnexus` / `superting`），每行一个开关。
- 点开关 → 调宿主已有的 `pluginManager` Remote（`setPluginEnabled`）→ 写 profile 补丁 →
  由 Loader 的 reload 生命周期**立即**卸载/挂载该 MCP 客户端进程，并同步移除/恢复它的工具。
- 显示结果：已应用 / 需重启 / 被覆盖 / 失败（含原因），以及每行的 entryId 与只读原因。

## 安装

```bash
git clone https://github.com/AbelKeithsun/dsh-mcp-switch.git
# 然后在 Harness 会话里用 plugin_manager 工具：
#   action: install_bundle
#   target: <克隆下来的绝对目录，如 /Users/you/dsh-mcp-switch>
```

安装会把包 `link:` 进 `$DSH_PROFILE_DIR/node_modules` 并把
`@local/dsh-mcp-switch` 加入 `package.json` 的 `dsh.profile.bundles`；
`cordis.patch.yml` 里新增一行 `mcp-switch`。它是纯 JS 本地包，无依赖、无构建、不发布。

安装后确认：`cordis_inspect_query`（client `Slots.listSubTree`，root `settings.section`）
的 occupants 里应出现 `mcp-switch`。

## 同步到 GitHub（维护者）

本仓库的工作副本同时活在 ops 工作区的 `dsh-mcp-switch/` 子目录里，用 `git subtree`
推送该子目录的独立历史，不引入嵌套仓库：

```bash
cd <本仓库工作副本所在的 ops 工作区>
git subtree push --prefix=dsh-mcp-switch \
  https://github.com/AbelKeithsun/dsh-mcp-switch.git main
```

（GitHub 访问需走本机代理：`HTTPS_PROXY=http://127.0.0.1:7897`。）

## DSH 版本兼容（升级前必读）

### 声明写在哪、谁在读

DSH 的兼容校验（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`）
**只读 `package.json` 里 `peerDependencies` 中 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的 semver 范围**；
`engines` 与 `dsh.engines` 都不参与校验（仅生态/市场展示）。不声明 peer = 校验被完全跳过，
未来任何 DSH 版本都会静默加载。本插件声明：

| 字段 | 值 | 作用 |
|---|---|---|
| `peerDependencies["@deepseek-ai/dsh"]` | `^0.2.0-rc.2` | **DSH 读它做校验**：0.2.x 放行，0.3.0 起判定不兼容 |
| `peerDependenciesMeta["@deepseek-ai/dsh"].optional` | `true` | 只影响包管理器实参（profile 已 `autoInstallPeers: false`），不影响 DSH 校验 |
| `dsh.engines.dsh` | `^0.2.0-rc.2` | 与 peer 同步的展示用镜像 |
| `dsh.testedWith` | `["0.2.0-rc.2"]` | **真正实测过的版本清单**，`npm run compat` 用它判定 |

判定不兼容时的行为（源码实证）：该 bundle 的行被 **skip / disabled 并打印原因**，
不会拖垮整个 profile 启动。修复二选一：更新本插件的声明，或用
`dsh plugin allow-version` / 插件管理器的「精确版本豁免」显式接受风险
（豁免是 `插件名@版本` × `运行版本` 的精确配对，记录在
`$DSH_PROFILE_DIR/compatibility.json`）。

### 升级 DSH 之后怎么迭代

```bash
npm run compat              # 自动探测运行版本；不在实测清单则退出码 1
npm run compat -- 0.3.0-rc.1  # 升级前预演
```

退出码非 0 时，按脚本打印的清单复验这 5 个依赖面（任一变了就要改 `client.js` 并重新实测）：

1. **客户端模块格式**：`window.__ModuleLoader__.load({ id, factory })`；
2. **设置页槽位**：`settings.section` 是否还在、注册项 `{ id, order, label, locale, inject }` 是否仍被接受
   （`cordis_inspect_query`，client `Slots.listSubTree`，root=`settings.section`）；
3. **宿主 Remote**：`pluginManager.listPlugins` / `setPluginEnabled` 的签名与返回信封 `{ ok, value }`
   （client `Service.listService`）；
4. **事件名**：`plugin-manager/changed`、`connection/reset`；
5. **端到端实测**：设置 → MCP 服务，关一个再开回来，确认 `application: applied`。

全过之后：把新版本加进 `dsh.testedWith` → 按需放宽/收紧 `peerDependencies`
→ 升 `version` → 提交并发新 Release（tag 指向最新提交）。

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（web，纯 JS 无构建） |
| `cordis.patch.yml` | 插入宿主行 `mcp-switch` |
| `index.js` | 宿主半边：不注册任何东西（操作全走已有 `pluginManager` Remote） |
| `client.js` | 浏览器半边：`settings.section` 里注册 `MCP 服务` 页（order 16） |
| `tests/client.test.mjs` | 行为测试：行过滤、命名回退、开关结果、错误路径、清理注册（6 项） |
| `tests/compat.test.mjs` | 兼容声明回归：peer 范围存在、engines 与之一致、testedWith 合法、脚本退出码（5 项） |
| `scripts/check-compat.mjs` | `npm run compat`：比对运行中的 DSH 版本与实测清单，未实测则打印复验清单并退出 1 |
| `locale/{zh,en}.json` | 插件管理页用的展示文案 |

## 测试

```bash
npm test            # 11 项：客户端行为 6 + 兼容声明 5
npm run compat      # 本机 DSH 版本是否在实测清单里
```

测试用假的 `window.__ModuleLoader__` / React / 浏览器 ctx 跑真实的 `apply()` 与 store，
断言只挑 MCP 行、未知行回退成 patch id、四种宿主结果（applied / restart-required /
overridden / ok:false / throw）都能落到页面上。

## 为什么有的行"被覆盖"、开不动

DSH 的 profile 组合顺序（见 `@deepseek-ai/dsh` 的 `profile-boot`）：

```
bundle 层（dsh.profile.bundles 顺序） → profile 的 cordis.patch.yml
  → 机器级层 $DSH_HOME/cordis.patch.yml（对本机所有 profile 生效，优先级更高）
  → --patch 覆盖层
```

`pluginManager.setPluginEnabled` 只写 **profile 补丁**。所以声明在
`$DSH_HOME/cordis.patch.yml` 里的行，profile 层关不掉它——页面会显示"被覆盖"。
要让这类行可开关，把该行的 `insert` 段从机器级层移到 profile 补丁里
（`$DSH_PROFILE_DIR/cordis.patch.yml`）。

### 2026-10-16 的实际改动

`rea-mcp` 原本声明在机器级层 `~/.dsh/cordis.patch.yml`，因此在页面里点不动。
已把它下沉到 desktop profile 补丁 `~/.dsh/profiles/desktop/cordis.patch.yml`
（与 `mcp-gitnexus` / `mcp-superting` 放在同一个 `insert:` 列表里），机器级层留空 `[]`。

- 备份：`~/.dsh/cordis.patch.yml.bak-20261016-161143`、
  `~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261016-161143`
- 代价：其它 profile（如 `profiles/web`）不再自动获得 rea；需要时把同一段
  `insert` 复制进那个 profile 的 `cordis.patch.yml`，它也能在那个 profile 里被开关。
- 回滚：把两个 `.bak-*` 覆盖回去即可（rea 会重新变成机器级、不可开关）。

## 排查

- 页面不出现：`cordis_inspect_query` 查 client `Slots.listSubTree` 的
  `settings.section` occupants 里有没有 `mcp-switch`；没有就说明 client 半边没加载
  （看 `dsh.client` 清单与浏览器 console 的 slot 报错）。
- 点了没反应：页面里的错误行会带原因；也可直接调 `plugin_manager` 的
  `set_plugin`（target 用 `include:<patchId>`）对比结果。
