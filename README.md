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

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（web，纯 JS 无构建） |
| `cordis.patch.yml` | 插入宿主行 `mcp-switch` |
| `index.js` | 宿主半边：不注册任何东西（操作全走已有 `pluginManager` Remote） |
| `client.js` | 浏览器半边：`settings.section` 里注册 `MCP 服务` 页（order 16） |
| `tests/client.test.mjs` | 行为测试：行过滤、命名回退、开关结果、错误路径、清理注册 |
| `locale/{zh,en}.json` | 插件管理页用的展示文案 |

## 测试

```bash
node --test tests/client.test.mjs
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
