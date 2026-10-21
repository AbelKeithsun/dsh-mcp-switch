# 交接日志（HANDOFF）

> **倒序**：最新在最上面。每次会话收尾**必须**在此追加一条，格式见 [`../AGENTS.md`](../AGENTS.md) 第 7 节。
> 只写可复现的事实；推测标注"未验证"。状态类信息（版本/发布/待办）以本文件为准。

---

## 2026-10-21 v0.3.0：未开启也能预览（独立探测 + 磁盘缓存），取代 v0.2.0 的"启用后才读"

- **背景/目标**：用户指出上一版方向不对：开关只决定 Agent 侧挂不挂载 MCP 客户端，MCP 服务本身一直存在，**应该在开关之前就能看工具**；并且"读过一次就缓存，配置没变就引用"。v0.2.0 的"启用后才读"被否决（v0.2.0 从未提交/发布，直接由本版取代）。
- **改了什么**：
  - **`probe.js`（新，零依赖 MCP 探测客户端）**：`probeServer(config)` 自己连服务读 `tools/list`。stdio = spawn `command args…` 走换行分隔 JSON-RPC；streamable-http = POST JSON-RPC，兼容 JSON 与单次 SSE 响应；`initialize` → `notifications/initialized` → `tools/list`（支持 `nextCursor` 分页）；20s 超时、SIGTERM/SIGKILL 清理、stderr 尾部附进错误；协议版本先试 `2025-06-18` 再退 `2024-11-05`；只投影 `{name, description, parameters[{name,required}]}`。`configFingerprint` = 解析后配置（transport/command/args/cwd/env/url/headers）的 SHA-256。
  - **`index.js`**：新增 `POST /api/mcp-switch/probe`（body `{entryId, force?}`）：未变配置命中磁盘缓存直接返回；否则探测、写缓存、返回。`GET /servers` 现在合并 `probe`（指纹匹配）与实时工具。缓存文件 `$DSH_HOME/cache/mcp-switch/probe.json`（只有工具元数据/时间/协议版本/指纹，**无 secret**），写入用 tmp+rename。关闭行没有 Fiber，配置里的 `!!js`（如 superting Bearer token）用 `entry.evaluate` 现算。实时工具回写缓存时增加"仅启用中 + 不缩小"保护（见坑）。两条路由都走同一回环/同源围栏。
  - **`client.js`**：预览就绪后对"没有任何数据"的行**顺序自动探测**（不会一次 spawn 多个服务），每行显示 读取中 / 工具列表 / 读取失败原因 + 「重新读取」；数据来源优先级 = 实时 > 探测缓存 > 内存 last-seen；标注 `实时` / `读取于 <时间>` / `上次启用时读到`。
  - 测试：新增 `tests/probe.test.mjs`（6 项，真实 stdio 子进程 + 本地 HTTP JSON/SSE fixture，`tests/fixtures/mcp-stdio-server.mjs`）；`tests/host.test.mjs` +5（探测读写缓存、配置变更失效、`!!js` 求值、探测围栏、实时回写）共 13 项；`tests/client.test.mjs` +2（未开启自动探测、失败重试）共 11 项。`package.json` version 0.3.0、`files` 加 `probe.js`、`test` 脚本加 probe 测试；README/AGENTS/`scripts/check-compat.mjs` 复验清单同步（第 5 项改为"预览/探测路由"）。
- **验证（原始结论）**：
  - `npm test` → **35/35 pass**；`npm run compat` → `0.2.1-rc.2` 在实测清单，exit 0。
  - 运行中的 DSH（0.2.1-rc.2）实测 `POST /api/mcp-switch/probe`（三个服务都真实连过）：
    `include:mcp-gitnexus`（当时停用）→ 13 tools、1.04s；`include:rea-mcp`（当时停用）→ **187 tools**、1.20s；`include:mcp-superting` → 14 tools、65ms（缓存命中）。协议均为 `2025-06-18`，serverInfo 分别为 gitnexus/1.6.6、rea/6.4.0、superting-local/2.0.15。
  - `GET /servers` 在 gitnexus/rea 停用状态下返回 `probe` 13/187 条；把 superting 临时停用后仍显示 probe 14 条（不再回退成"启用后自动读取"）；停用状态下对 superting 强制探测也成功（证明 `!!js` token 求值有效）。
  - 缓存文件 115,688 bytes；`grep -c 'Authorization\|Bearer\|SUPERTING_MCP_TOKEN'` → **0**（无 secret）。profile 补丁已还原到改动前备份，`diff` 为空；MCP 开关状态与开始时一致（gitnexus/rea 停用、superting 启用）。
  - **未验证**：页面视觉与自动探测在浏览器里的交互（无浏览器控制）。
- **当前状态**：version **0.3.0**；运行中的 DSH 0.2.1-rc.2；**已按发版四步发布**：
  - 发布提交 `8259473`（feat：未开启即可预览），已 push 到 `origin/main`；
  - annotated tag **`v0.3.0`**（tag 对象 `e23f19e` → 解引用 commit `8259473`，与发布时 main 一致）；
  - GitHub Release 已建（非 draft、非 prerelease）：<https://github.com/AbelKeithsun/dsh-mcp-switch/releases/tag/v0.3.0>；
  - 发布后仅追加一次 docs 提交（修正 AGENTS 第 6 节对 annotated tag 的自检命令），main 会因此领先 tag 一个 docs 提交，属预期；
  - 探测缓存已含三台服务的真实清单（`~/.dsh/cache/mcp-switch/probe.json`）。
- **未完成 & 下一步**：① 用户刷新页面确认「查看工具 / 读取中 / 重新读取 / 读取于时间」的视觉；② 若后续有 HTTP 服务需要 OAuth 交互授权，探测会报错，需要单独评估（本机 token 型配置不受影响）。
- **坑**：
  1. **探测缓存也会被"逐个注销"坑到**：第一版把实时工具直接回写磁盘缓存，停用 superting 时每次 `tools/change` 都把更小的清单写进去，缓存从 14 变成 1。修复：只在**行仍启用**且清单**不缩小**（或配置指纹变了）时回写；实测停用后缓存保持 14，并有单测 `teardown events do not shrink the cached snapshot` 的同族用例。
  2. **关闭行的配置里有 `!!js`**：Loader 只在 Fiber 上有 resolved config；关闭行必须递归把 `{__jsExpr}` 交给 `entry.evaluate()` 求值，否则 superting 的 Bearer token 会变成对象/空值。已用"停用 superting 后强制探测成功"实测。
  3. **自动探测要顺序执行**：三个服务里 rea 有 187 个工具、Gitnexa/rea 是真实子进程，并发探测会同时 spawn；页面用串行 `await`。
  4. **stdio 必须确保 kill**：探测成功/失败/超时都要 `SIGTERM` 后 500ms `SIGKILL`，否则测试与 Host 会留下子进程。
  5. **HTTP 有 JSON 和 SSE 两种合法响应**：只读 `response.json()` 会在 SSE 下失败；`probe.js` 分别处理，并流式读 SSE 避免长连接挂住。
  6. **rea 工具多**：187 个工具让 GET payload ≈ 123KB，本机无感；若以后服务特别多，可考虑分页/懒加载（未做）。
  7. 备份：`~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261021-210623`（本次所有实验的原始基线）；验证中的临时副本在 `/tmp/cordis-*`。回滚：把 `.bak-20261021-210623` 覆盖回 `cordis.patch.yml`。

---

## 2026-10-21 v0.2.0：MCP 工具预览（只读 Host 路由 + 每行可展开的工具清单）

- **背景/目标**：用户有了 MCP 开关页，但开关前看不到每个 MCP 服务器提供哪些服务（工具），"打开/关闭心里没底"。要在设置页里预览每个服务的工具清单。
- **改了什么**：
  - `index.js`（宿主半边，从 `apply(){}` 改为一条只读路由）：`GET /api/mcp-switch/servers`；`ctx.loader.entries()` 取 `@deepseek-ai/dsh-mcp-client` 行（`serverName` / `transport` / `entryId`），`ctx.tools.schemas()` 按 `mcp__<serverName>__` 前缀映射工具（name / description / 参数名）；内存 `lastSeen` 快照缓存（`tools/change` 监听 + 激活时预热）；回环围栏（socket 回环 + Host 回环 + `Sec-Fetch-Site`/`Origin` 同源检查）；只返回工具元数据，**不发 env/headers/args/cwd/URL**。
  - `client.js`：store 增加 `loadPreview()`（fetch 路由）、`localStorage` 快照（key `dsh.mcp-switch.preview.v1`）、`previewForEntry()`（按 entryId / serverName / patchId 关联）、开关后 1.2s/3s 重试预览；`Row` 增加"查看工具 · N"折叠列表（工具名、参数名与必填标记、描述）、停用服务显示"上次启用时读到"的缓存清单；新增 `mcps-preview*` / `mcps-tool*` 样式（只用 `--dsw-alias-*` token）与 zh/en 文案。
  - `tests/host.test.mjs`（新，8 项）：工具映射与参数、secret 不泄漏、停用后缓存、`tools/change` 预热、关停时逐个注销不收缩缓存、回环/跨站/方法围栏、loader 故障 500。
  - `tests/client.test.mjs` +3 项（预览读取/持久化、缓存回退、路由不可用不影响开关）；`package.json` `test` 脚本加 host 测试；`version` 0.1.1→0.2.0；`dsh.testedWith` 加 `0.2.1-rc.2`；README/AGENTS/`scripts/check-compat.mjs` 复验清单同步（新增第 5 项"预览路由"）。
- **验证**（原始结论）：
  - `npm test` → 22/22 pass；`npm run compat` → 运行版本 `0.2.1-rc.2` 在实测清单，exit 0。
  - 运行中的 DSH（0.2.1-rc.2，desktop profile）已加载新 Host 代码（改 profile 补丁触发 recomposition）：
    `curl http://127.0.0.1:57765/api/mcp-switch/servers` → 200，`superting` live 14 个工具、`gitnexus`/`rea` 因本来就停用而为 0；`curl -H 'Host: 192.168.1.50:57765'` → 403，`Sec-Fetch-Site: cross-site` → 403，`Origin: http://evil.example` → 403，`POST` → 405。
  - 真实开关（经 profile 补丁 `- id: mcp-superting\n  disabled: true` 触发 Loader dispose，与 `setPluginEnabled` 写补丁同一路径）：关掉后 `enabled=false, live=0, cached=14`；去掉覆盖后可回 `enabled=true, live=14, cached=0`。之后 profile 补丁已还原到备份，`diff` 为空，MCP 状态与开始时一致（gitnexus/rea 停用、superting 启用）。
  - **未验证**：页面视觉（无浏览器控制；Playwright 访问该 GUI 需鉴权）。需用户刷新页面后目测「设置 → MCP 服务」的工具折叠与缓存标签。
- **当前状态**：version 0.2.0；运行中的 DSH 0.2.1-rc.2；**未提交/未推送/未打 tag**（等用户确认 UI 后再按发版四步走）。
- **未完成 & 下一步**：① 用户刷新页面确认视觉与交互（展开/收起、停用后的"上次启用时"标签）；② 确认后 commit + push（`HTTPS_PROXY=http://127.0.0.1:7897`）+ tag `v0.2.0` + GitHub Release；③ 可选：给 `gitnexus` / `rea` 各启用一次，让预览缓存有数据（当前从未在本进程内启用过，所以显示"启用后自动读取"）。
- **坑**：
  1. **HMR 不监视链接包源码**：desktop 的 hmr `root: []`，改 `index.js`/`client.js` 不会自动重载；改一行 profile 补丁触发 recomposition 才会重新加载"文件已变化"的链接包（本会话实测）。客户端页面刷新后拿新 bundle。
  2. **工具是逐个注销的**：停用一个 MCP 服务时每次 unregister 都发 `tools/change`，天真的缓存会被中间态覆盖成 1 个工具（本会话实测踩到）；现在"收缩的 live 集合不覆盖快照，只有 0→live 的新一代或增长才更新"，并有单测守住。
  3. **exact 路由在 `/api` 鉴权前缀之前匹配**：`/api/mcp-switch/servers` 不会经过 DSH 的 `/api` 鉴权，所以必须自带 loopback/同源围栏（照 dsh-ssh 的做法）。
  4. **缓存只在"该 Host 进程里启用过"时才有**：当前 gitnexus/rea 本来就停用，预览对它们只能显示"启用后自动读取"；`localStorage` 快照也只记录页面见过的服务。
  5. 相关备份：`~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261021-210623`（改动前原始）、`.bak-20261021-210651-before-toggle-test`、`.bak-20261021-2106*-before-toggle-test2`；回滚任一 `.bak-*` 覆盖回 `cordis.patch.yml` 即可。

---

## 2026-10-16 项目从 ops 迁到 workspace/open-source（ops 只放运维信息）

- **背景/目标**：用户要求 `~/Documents/note/ops` 只存放运维信息，不存放具体项目代码；本项目迁到 `~/Documents/workspace/open-source/dsh-mcp-switch`。
- **改了什么**：整目录迁移；新位置 `git init` 并对齐 GitHub 历史（不再用 `git subtree`）；`README.md` 的"同步到 GitHub（维护者）"段改为常规 git 流程；ops 仓库提交 `3a7ff10` 删除该目录。
- **迁移顺序（零停机，可复用）**：① `cp -a` 到新位置 → 逐文件 shasum 指纹比对；② `plugin_manager install_bundle` 指向**新路径**（依赖 spec 变化可被管理器归属，因此 profile `package.json` + `pnpm-lock.yaml` + `node_modules/@local/` 符号链接三处自动重指）；③ 新位置 `git init -b main` + `git remote add origin` + `git fetch origin main` + `git update-ref refs/heads/main FETCH_HEAD` + `git reset --mixed`（直接继承 5 个提交，worktree 干净）；④ 四重校验（路径字符串、新位置是合法仓库且文件齐全、profile 链接指向新路径、两边内容指纹一致）后才 `rm -rf` 旧副本。
- **验证**：迁移全程 `settings.section` occupants 里 `mcp-switch` 始终 `active`（含删掉旧目录之后）；新位置 `npm test` 11/11、`npm run compat` exit 0；`readlink ~/.dsh/profiles/desktop/node_modules/@local/dsh-mcp-switch` → `.../workspace/open-source/dsh-mcp-switch` 且 `client.js` 可读；远端 `main = 84d6417`。
- **当前状态**：version 0.1.1；运行中的 DSH 0.2.0-rc.2（profile `desktop`）；最新 tag `v0.1.1`（指向 `9fdd157`，其后只有文档提交）。
- **未完成 & 下一步**：① 这次重指 link 的安装返回 `application: restart-required`——**建议找时间重启一次 dsh** 以加载新位置的新模块代（不重启也不会坏：客户端 bundle 在 `clientModules` 图里是内存字节，旧目录已删仍能继续服务当前页面）。
- **坑**：`install_bundle` 对"已 link 且无变化"的目录重复调用会返回 `ambiguous-install`（pnpm 幂等、但管理器按 spec 前缀无法归属目标）——这不是故障，改路径时直接用新路径 install 即可。

---

## 2026-10-16 v0.1.1：声明 DSH 版本兼容 + 升级自检工具

- **背景/目标**：用户问"是否已设置对应 DSH 版本"，因为后续要跟着 DSH 升级迭代。
- **改了什么**：`package.json` 加 `peerDependencies["@deepseek-ai/dsh"]=^0.2.0-rc.2`、`peerDependenciesMeta[...].optional=true`、`dsh.engines.dsh`（镜像）、`dsh.testedWith=["0.2.0-rc.2"]`；新增 `scripts/check-compat.mjs`（`npm run compat`）与 `tests/compat.test.mjs`（5 项）；README 加「DSH 版本兼容」章节与升级 5 项复验清单。
- **关键结论（源码 + 实证）**：DSH 的 `evaluatePluginCompatibility`（`@deepseek-ai/dsh-app-boot`）**只读 `peerDependencies` 里 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 semver 范围**；`engines` 与 `dsh.engines` **完全不参与校验**；未声明 peer = 整段校验被跳过（`if (!Object.hasOwn(fields, "peerDependencies")) return void 0`）。
- **实证**：临时把范围改成 `^99.0.0` → `plugin_manager list_bundles` 返回 `error.code=incompatible-version`（含 name/version/runtimeVersion/peers）且 `rows: []`；不兼容时该 bundle 的行被丢弃、启动时 skip 并打印原因（不拖垮 profile）。还原后把插件**自身行** `set_plugin` off/on 两次，均 `application: applied`，设置页恢复注册。
- **验证**：`npm test` 11/11（客户端 6 + 兼容 5）；`npm run compat` 探测源 `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` 的 `desktopVersion=0.2.0-rc.2`，exit 0；`npm run compat -- 0.3.0-rc.1` exit 1 并打印复验清单。
- **当前状态**：v0.1.1；GitHub Release `v0.1.1` 已建，tag=`main`=`9fdd157`（提交前 amend 修掉了手滑的 `yuxin.ccom` 邮箱）。
- **坑**：声明 peer 前先确认 profile 的 `pnpm-workspace.yaml` 有 `autoInstallPeers: false`（本机有），否则 pnpm 可能去 registry 拉运行时。

---

## 2026-10-16 上传 GitHub（public · MIT · tag/Release）

- **背景/目标**：用户要求上传到自己的 GitHub。
- **改了什么**：补 `LICENSE`(MIT)、`.gitignore`、`package.json` 的 `license`/`repository`；README 安装段改为 `git clone` + `install_bundle <绝对目录>`，去掉 README 里本机绝对路径。
- **做法**：当时仓库还在 ops 的子目录，用 `git subtree push --prefix=dsh-mcp-switch <url> main` 推成独立历史（**已废弃**：迁出后改用常规 git，见最新一条）。仓库：`gh repo create AbelKeithsun/dsh-mcp-switch --public`，topics `dsh/deepseek-harness/mcp/plugin/settings`。
- **验证**：上传前扫描明文凭据（无命中）；6 个关键文件远端 base64 解码后与本地 sha256 逐一对齐；`gh release create v0.1.0` 后自检 tag 与 main 对齐；远端 raw README 可公开读取。
- **当前状态**：GitHub history `e6ef323`(feat) → `80f9e6c`(chore LICENSE) → `1b80ad3`(docs README) → `b44921d`(docs 去本机路径) → `9fdd157`(feat compat v0.1.1) → `84d6417`(docs 迁移)。
- **坑**：仓库工作副本当时在 ops 里，`git status` 会把项目当作 ops 的一部分——这也是本文件最新一条迁移的起因。

---

## 2026-10-16 首次交付：设置内「MCP 服务」开关页

- **背景/目标**：用户要"一个可以对 MCP 服务进行开关的模式"。确认形态：**GUI 设置面板 + 按服务单独开关**（用户在两选项里明确选了 GUI 面板与单服务粒度）。
- **改了什么**：从零建 bundle `@local/dsh-mcp-switch`——`client.js` 在 `settings.section` 注册 order 16 的页面，列出所有 `@deepseek-ai/dsh-mcp-client` 行并逐个开关（走 `pluginManager.listPlugins` / `setPluginEnabled`）；`index.js` 空壳；`cordis.patch.yml` 插一行；`tests/client.test.mjs` 6 项行为测试；`locale/{zh,en}.json` + `icon.svg`。
- **实现依据**：DSH 内置技能 `cordis-plugin-development`（`SKILL.md` + `references/ui-plugin.md`，位于 `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/`，只能用宿主文件读取工具读，shell/ripgrep 读不了 asar）。
- **验证**：`superting` 关 → `application: applied`，**本次会话运行时 MCP 列表当场 3→2**（工具随之消失）→ 开回来恢复 3；`rea` 同样关/开各一次并还原；客户端注册用 `Slots.listSubTree` 确认 `mcp-switch`(order 16, active)。
- **关键结论（配置层）**：`rea-mcp` 原本声明在**机器级层** `$DSH_HOME/cordis.patch.yml`，该层优先级高于 profile 补丁（见 `@deepseek-ai/dsh` 的 `profile-boot` 注释），而 `setPluginEnabled` 只写 profile 补丁 → 点开关返回 `overridden`。已把该行下沉到 `~/.dsh/profiles/desktop/cordis.patch.yml`（与 gitnexus/superting 同一个 `insert:` 列表），机器级层留空 `[]`，rea 随即返回 `applied`。备份：`~/.dsh/cordis.patch.yml.bak-20261016-161143`、`~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261016-161143`。**回滚**：两个 `.bak-*` 覆盖回去。
- **验证边界（如实记录）**：用 `playwright-cli -s=<s> open http://127.0.0.1:19387` 拿到 **401**（新浏览器客户端无鉴权），按 DSH 规范**未去翻找 token**，因此**视觉渲染未由我截图确认**——依据是"客户端槽位已注册 + 真实 Remote 开关实测 + 11 项单测"。用户侧看一眼「设置 → MCP 服务」即可确认外观。
- **未完成 & 下一步**：① 无 CI（可加 GitHub Actions：`npm test` + `npm run compat`）；② 若需要批量「全开/全关」按钮可加（当初用户明确只要单服务开关，故未做）；③ 英文 README / 发布到 npm registry 均未做。
