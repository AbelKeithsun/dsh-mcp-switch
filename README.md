# dsh-mcp-switch — Harness 的「MCP 服务」开关页

> GitHub: <https://github.com/AbelKeithsun/dsh-mcp-switch> · MIT

在 DSH Web UI 的 **设置 → MCP 服务** 里先看清每个 MCP 服务器提供哪些工具，
再逐个启用/停用；开关运行时热生效，不用重启 Harness。

## 它做什么

- 列出本 profile 里所有 `@deepseek-ai/dsh-mcp-client` 的 Loader 行（当前是 `rea` /
  `gitnexus` / `superting`），每行一个开关。
- 点开关 → 调宿主已有的 `pluginManager` Remote（`setPluginEnabled`）→ 写 profile 补丁 →
  由 Loader 的 reload 生命周期**立即**卸载/挂载该 MCP 客户端进程，并同步移除/恢复它的工具。
- 显示结果：已应用 / 需重启 / 被覆盖 / 失败（含原因），以及每行的 entryId 与只读原因。
- **工具预览（不用先开启）**：每行可展开「查看工具 · N」，列出该服务器真实提供的工具名、
  参数名、说明。第一次打开页面时会自动为没有数据的服务建立连接读一次 `tools/list`，
  结果按配置指纹缓存在磁盘上；之后直接引用缓存，配置没变就不会重复连接。
- 开启中的服务显示**实时**工具清单；关闭的服务显示缓存清单并标注读取时间。
  也可以手动「重新读取」，或对某个服务单独读取（读取失败会显示原因并可重试）。

## 工具预览是怎么来的（Host 半边）

**开关只决定 Agent 侧要不要挂载 MCP 客户端；MCP 服务本身一直存在。** 所以预览不依赖开关：
Host 半边可以用 profile 里已有的 server 配置**自己连过去**问一次 `tools/list`。

### 两条只读本机路由

```
GET  /api/mcp-switch/servers   # 页面现状：Loader 行 + 实时工具 + 探测缓存
POST /api/mcp-switch/probe     # { entryId, force? }：连接该服务读 tools/list 并缓存
```

- `GET` 从 `ctx.loader.entries()` 找 `@deepseek-ai/dsh-mcp-client` 行（`serverName` / `transport` /
  `entryId`），再从 `ctx.tools.schemas()`（模型可见工具的全局视图）按 `mcp__<serverName>__` 前缀
  取回实时工具，并附上磁盘缓存里的探测结果。
- `POST` 用该行的**已解析配置**连接服务：`stdio` 就 spawn `command args…` 走换行分隔的 JSON-RPC，
  `streamable-http` 就 POST JSON-RPC（兼容 JSON 与 SSE 两种响应），完成 `initialize` →
  `notifications/initialized` → `tools/list`（支持分页）后立即断开。实现见 [`probe.js`](<probe.js>)：
  零依赖，只用 Node 内置模块。
- 行被关闭时没有运行中的 Fiber，配置里的 `!!js` 表达式（例如 superting 的 Bearer token）由
  Loader 的 `evaluate` 现算，不需要该行处于启用状态。

### 缓存与失效

- 落盘位置：`$DSH_HOME/cache/mcp-switch/probe.json`（通常是 `~/.dsh/cache/mcp-switch/probe.json`），
  内容只有工具元数据、时间戳、协议版本和**配置指纹**，不含 command/args/env/headers/token。
- 指纹 = 解析后配置（transport / command / args / cwd / url / headers / env）的 SHA-256。
  配置任何一项变化（含 token 轮换）→ 缓存失效，页面下次打开会重新探测。
- 开启中的服务每次读取都会把实时工具回写缓存；关闭时工具是**逐个注销**的，回写只在行仍启用
  且清单不缩小时发生，避免把完整清单覆盖成 1 个工具（有专门单测）。
- 页面另在 `localStorage`（key `dsh.mcp-switch.preview.v1`）存一份展示快照，供 Host 路由不可用时兜底。

### 安全边界

- 两条 exact 路由都在 DSH 的 `/api` 鉴权前缀之前匹配，因此自带本机围栏：socket 必须是回环地址、
  `Host` 必须是回环主机、`Sec-Fetch-Site: cross-site` 与不匹配的 `Origin` 一律 403；
  `GET`/`POST` 之外 405，请求体上限 4 KiB。
- 探测只是读：不调用任何 MCP 工具、不改 profile、不把配置发给浏览器。它执行的命令与"打开该服务"
  时 Loader 执行的命令相同，同样只信任本机操作者。
- 通过局域网 IP 打开 DSH 时预览显示"暂不可用"，开关本身不受影响。

### 限制

- 只覆盖主 Loader 树里的 MCP 行（agent preset 内部组合的 MCP 行不在预览范围）。
- 只列工具，不列 MCP resources / prompts。
- HTTP 服务若要求浏览器 OAuth 之类的交互式授权，探测会如实报错（本机 token 型配置不受影响）。

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

## 开发（维护者）

本仓库就是工作副本，位于 `~/Documents/workspace/open-source/dsh-mcp-switch`，
与 GitHub 的 `origin/main` 常规同步（不再借助 `git subtree`）：

```bash
npm test                       # 35 项
npm run compat                 # 本机 DSH 版本是否在实测清单里
git add -A && git commit -m "..." && git push origin main
```

DSH profile 通过 `link:` 依赖指向本目录（`install_bundle` 写入），改动即时生效；
但**替换已安装包的代码需要重启 dsh** 才会加载新的一代 JS 模块（插件管理器的
`application: restart-required` 就是这个意思）。

（GitHub 访问需走本机代理：`HTTPS_PROXY=http://127.0.0.1:7897`。）

## 接手 / 参与开发

- **[`AGENTS.md`](AGENTS.md)** — 项目级 agent 指令（DSH 会自动注入以本目录为工作区的会话）：
  30 秒速览、启动自检命令、硬约定、验证矩阵、发版四步、会话交接纪律。
- **[`docs/HANDOFF.md`](docs/HANDOFF.md)** — 交接日志（倒序）：每次会话做了什么、跑了什么验证、
  当前版本与发布状态、未完成项、踩过的坑。**新会话先读它 + `git log`，不要依赖聊天记录。**

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
| `dsh.testedWith` | `["0.2.0-rc.2", "0.2.1-rc.2"]` | **真正实测过的版本清单**，`npm run compat` 用它判定 |

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

退出码非 0 时，按脚本打印的清单复验这 6 个依赖面（任一变了就要改代码并重新实测）：

1. **客户端模块格式**：`window.__ModuleLoader__.load({ id, factory })`；
2. **设置页槽位**：`settings.section` 是否还在、注册项 `{ id, order, label, locale, inject }` 是否仍被接受
   （`cordis_inspect_query`，client `Slots.listSubTree`，root=`settings.section`）；
3. **宿主 Remote**：`pluginManager.listPlugins` / `setPluginEnabled` 的签名与返回信封 `{ ok, value }`
   （client `Service.listService`）；
4. **事件名**：`plugin-manager/changed`、`connection/reset`；
5. **预览/探测路由**：`ctx.webServer.register({ kind, path, handler })`、`ctx.tools.schemas()`、
   `ctx.loader.entries()`、`entry.fiber.config` 仍可用（`curl .../api/mcp-switch/servers` 返回 200；
   `curl -X POST .../api/mcp-switch/probe -d '{"entryId":"include:<patchId>"}'` 返回工具数组）；
6. **端到端实测**：设置 → MCP 服务，关一个再开回来，确认 `application: applied`，
   且关闭状态下仍能「查看工具」（来自探测缓存）。

全过之后：把新版本加进 `dsh.testedWith` → 按需放宽/收紧 `peerDependencies`
→ 升 `version` → 提交并发新 Release（tag 指向最新提交）。

## 目录

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（web，纯 JS 无构建） |
| `cordis.patch.yml` | 插入宿主行 `mcp-switch` |
| `index.js` | 宿主半边：`GET /servers` 现状 + `POST /probe` 独立探测、磁盘缓存、回环围栏（开关本身仍走已有 `pluginManager` Remote） |
| `probe.js` | 零依赖 MCP 探测客户端：stdio 换行 JSON-RPC、streamable-http（JSON/SSE）、tools/list 分页、超时清理 |
| `client.js` | 浏览器半边：`settings.section` 里注册 `MCP 服务` 页（order 16），含工具预览/自动探测/重试 UI |
| `tests/client.test.mjs` | 行为测试：行过滤、命名回退、开关结果、错误路径、清理注册、预览读取/缓存、自动探测与失败重试（11 项） |
| `tests/host.test.mjs` | 宿主路由测试：工具映射、密钥不泄漏、缓存不收缩、回环围栏、探测与缓存复用/失效、`!!js` 配置求值（13 项） |
| `tests/probe.test.mjs` | 探测客户端测试：指纹、stdio 子进程（真实 spawn）、HTTP JSON/SSE、鉴权失败、stderr 诊断（6 项） |
| `tests/fixtures/mcp-stdio-server.mjs` | 测试用最小 stdio MCP server（分页 tools/list） |
| `tests/compat.test.mjs` | 兼容声明回归：peer 范围存在、engines 与之一致、testedWith 合法、脚本退出码（5 项） |
| `scripts/check-compat.mjs` | `npm run compat`：比对运行中的 DSH 版本与实测清单，未实测则打印复验清单并退出 1 |
| `locale/{zh,en}.json` | 插件管理页用的展示文案 |
| `AGENTS.md` | 项目级 agent 指令：启动自检、硬约定、验证矩阵、发版流程、交接纪律 |
| `docs/HANDOFF.md` | 会话交接日志（倒序追加，状态类信息以它为准） |

## 测试

```bash
npm test            # 35 项：客户端行为 11 + 宿主路由 13 + 探测客户端 6 + 兼容声明 5
npm run compat      # 本机 DSH 版本是否在实测清单里
```

客户端测试用假的 `window.__ModuleLoader__` / React / 浏览器 ctx（含 `fetch`、`localStorage`）
跑真实的 `apply()` 与 store；宿主测试用假的 `loader` / `tools` / `webServer` 跑真实的 `apply()`
并直接调用注册出来的 HTTP handler；探测测试用真实的子进程与本地 HTTP 服务。覆盖：只挑 MCP 行、
未知行回退成 patch id、四种宿主结果、工具映射与参数、密钥不泄漏、关停时的缓存收缩、
回环/跨站围栏、自动探测与失败重试、缓存复用与配置失效。

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
- 页面显示"工具预览暂不可用"：先在宿主机上 `curl http://127.0.0.1:<web 端口>/api/mcp-switch/servers`。
  200 说明路由正常（那就是浏览器不是走回环地址打开的）；403 是回环围栏；401/404 说明 Host 半边
  还没加载（profile 补丁改一下触发 recomposition，或重启 dsh）。
