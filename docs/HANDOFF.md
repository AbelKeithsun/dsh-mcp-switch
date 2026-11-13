# 交接日志（HANDOFF）

> **倒序**：最新在最上面。每次会话收尾**必须**在此追加一条，格式见 [`../AGENTS.md`](../AGENTS.md) 第 7 节。
> 只写可复现的事实；推测标注"未验证"。状态类信息（版本/发布/待办）以本文件为准。

---

## 2026-11-13 v0.4.0：修「启用行的 `!!js` 配置没求值」→ 探测 401（发布 v0.4.0）

- **背景/目标**：用户要求「提交推送并打 tag」，并给出 superting 的 token。核对 token 时发现它**与 profile 里内联的 token 完全相同**（`grep` 一致），且用同一 token 直连 `http://127.0.0.1:8220/mcp` → **200**、`serverInfo=superting-local/2.0.15`、返回 instructions；而插件的探测却稳定报 `initialize failed with HTTP 401` → **不是 token 过期，是插件的 bug**。
- **根因（源码 + 实测双证）**：DSH 0.2.2 的 Loader 把 `!!js` 表达式节点 `{__jsExpr: "..."}` 保留在**两处**：
  - `entry.options.config`（原始补丁配置）；
  - `entry.fiber.config`（**原始**输入，不是解析后的）。

  只有 `fiber.effectiveConfig` 才是插值后的副本（`cordis-plugin-loader/src/index.ts:104-110` 的 `internal/config` 钩子里 `interpolate(fiber.ctx, config)`）。

  本插件 `resolveServerConfig()` 之前优先取 `entry.fiber?.config` —— 对**启用行**拿到的就是还带着 `{__jsExpr}` 的原始对象，于是 `headers.Authorization` 被当成对象塞进 HTTP 头，Node `fetch` 把它字符串化成 **`[object Object]`** → 服务器 401。
  **停用行**反而没事：没有 fiber，走 `interpolateConfig()` 用 `entry.evaluate()` 求值了。
- **改了什么**：
  - **`index.js` `resolveServerConfig()`**：改为**优先**用 `entry.options?.config` + `interpolateConfig(entry, raw)`（对启用/停用行同一条路径，指纹稳定），仅当没有 `options.config` 时才回退 `entry.fiber?.effectiveConfig`。
  - **`tests/host.test.mjs`**：新增 1 项「the probe route resolves !!js config expressions for running rows too」——构造一个 `fiber.config` 与 `options.config` 都带 `{__jsExpr}` 的启用行，断言探测能跑通。**已验证该测试在旧逻辑下失败（13 pass / 1 fail）、新逻辑下通过（14 pass）**。
  - **`AGENTS.md` / `README.md`**：测试数 42→43、宿主路由 13→14 项。
- **验证（原始结论）**：
  - `npm test` → **43/43 pass**；`npm run compat` → exit 0（`运行中的 DSH 0.2.2-rc.2 ← 安装清单 app-boot`），`✔ 0.2.2-rc.2 在实测清单里`。
  - **抓到现场证据**（临时起一个本地 echo MCP server + 在 profile 里临时插一行 `mcp-echo`，事毕全部还原）：echo server 记录到 `Authorization: "Bearer a6a6…"`（DSH 自己的 MCP 客户端发的，**正确**）与 `Authorization: "[object Object]"`（本插件的探测发的，**错误**）——同一份配置、两条路径，一眼定位。
  - 修复后在**运行中的 DSH 0.2.2-rc.2** 上重测（改一行 profile 补丁触发 recomposition 让链接包重新载入）：
    `POST /api/mcp-switch/probe {"entryId":"include:mcp-superting","force":true}` → **200**、14 tools、`tokens={"tools":1221,"instructions":347,"total":1568}`、instructions 1344 字符（此前是 502/401，且缓存里 superting 的 `instructionsKnown` 一直是 `false`）。
    三个服务全部 200：superting 14 tools/1568 tokens、gitnexus 13 tools/5671、rea 187 tools/133064。
  - `GET /api/mcp-switch/servers` → 200，三行齐全（gitnexus/rea 停用、superting 启用，与开始时一致）。
  - profile 补丁已还原：`diff cordis.patch.yml cordis.patch.yml.bak-20261113-before-compat-toggle` → **空**（与本会话开始时逐字一致）。备份：`~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261113-before-compat-toggle`。
  - **未验证**：页面视觉（无浏览器控制）。
- **当前状态**：version **0.4.0**；运行中的 DSH **0.2.2-rc.2**；发布结果见下方「发布」小节。
- **未完成 & 下一步**：见「发布」小节。
- **坑**：
  1. **`entry.fiber.config` 是原始输入，不是解析后的配置**：DSH 0.2.2 里 `fiber.config` 保留 `!!js` 节点，只有 `fiber.effectiveConfig` 是插值后的。本插件曾用 `fiber.config` → 启用行的 header 变成 `[object Object]` → 401。**读配置一律走 `entry.options.config` + 自己求值**（与停用行同路径）。
  2. **这个 bug 只在「启用行 + `!!js` + HTTP 认证」三者同时成立时显形**：停用行走求值路径没事；stdio 没有 header 也没事；DSH 0.2.1 的 `fiber.config` 语义不同（那时是解析后的）所以升级后才暴露。**升级 DSH 后必须重新跑一遍三个服务的真实探测**。
  3. **`!!js` 里的 `process.env.X ?? '字面量'` 求值发生在 Host 进程**，本机 `SUPERTING_MCP_TOKEN` 未设置 → 实际用的是内联字面量 token；token 轮换要改 profile 补丁或设置环境变量后重启 DSH。
  4. **`npm run compat` 之前读的是桌面外壳版本**（0.2.2-rc.1）而非 CLI 版本（0.2.2-rc.2），已修（见上一条 2026-11-13 记录）。
  5. **让运行中的 DSH 重新载入链接包源码**：HMR 比较 profile 补丁的**内容**（不是 mtime），`touch` 无效；要**改一行内容**（本会话用追加一行注释）才会 recomposition。改完记得把那一行删回去。

---

## 2026-11-13 v0.4.0（同一次发布的前半）：语言包元信息 + AppleDouble 防护 + compat 版本探测修正 + 0.2.2-rc.2 复验

- **背景/目标**：另一台 Linux 机器（`/workspace/utils/plugins/dsh-mcp-switch`，从本机 macOS 整目录拷过去）报「包元信息错误」，根因是拷贝带进了 macOS 的 AppleDouble 旁注文件 `locale/._en.json`，而 DSH 0.2.2 的语言包加载器把 `locale/` 下**每个** `*.json` 都当语言字典并要求文件名是合法语言 id。用户要求本项目自查「有没有需要修复的地方」。
- **改了什么**：
  - **`locale/en.json` / `locale/zh.json`**：加 `meta.title` / `meta.description`（DSH 0.2.2+ 只认 `meta`；平铺键保留给更早的加载器）。改前真实加载器返回 `title.en = "@local/dsh-mcp-switch"`（回退成包名），改后 `title = {en:"MCP server switches", zh:"MCP 服务开关"}`。
  - **`package.json`**：`files` 里 `locale/*.json` → 显式 `locale/en.json` / `locale/zh.json`（通配正是垃圾文件进包的通道）；`dsh.testedWith` 增加 `0.2.2-rc.2`；`test` 脚本加 `tests/locale.test.mjs`。
  - **`.gitignore`**：加 `._*`（AppleDouble 旁注文件）。
  - **`scripts/check-compat.mjs`**：版本探测改为读**运行中的 DSH CLI 版本**（`$DSH_INSTALL_DIR/../dsh-app-boot/package.json`；在 `app.asar` 里用 `$DSH_NODE_EXECUTABLE` + `ELECTRON_RUN_AS_NODE` 读），再退回 CLI 包清单，最后才退回 `runtime.json` 的外壳版本并标注「可能与 CLI 不同」。改前本机报的是外壳版本 0.2.2-rc.1（假警报），改后是 CLI 版本 0.2.2-rc.2。同时修正注释：**顶层** `engines.dsh` 一票决定、`dsh.engines` 只用于展示、semver 比较带 `includePrerelease`。
  - **`tests/locale.test.mjs`**（新，6 项）：locale 目录只允许 en/zh 且文件名是合法语言 id、每个语言包带 `meta`、仓库无 `._*`、`files` 不用 locale 通配、`exports` 导出语言包、图标是包内普通文件。
  - **README / AGENTS.md**：兼容表（testedWith、engines 说明）、测试数 36→42、新增「语言包与打包边界（DSH 0.2.2+ 必读）」小节与真实加载器自查命令、硬约定新增第 4 条（语言包 = 展示元信息）、目录表与验证矩阵同步。
- **验证（原始结论）**：
  - `npm test` → **42/42 pass**；`npm run compat` → exit 0，输出 `运行中的 DSH 0.2.2-rc.2 ← 安装清单 app-boot …`、`✔ 0.2.2-rc.2 在实测清单里`。
  - 真实加载器（DSH 0.2.2-rc.2 的 `readPluginMeta`，经 `ELECTRON_RUN_AS_NODE` 调 app-boot）：改前 `title.en="@local/dsh-mcp-switch"`；在 `locale/` 放一个 `._en.json` 后报 `Plugin metadata for @local/dsh-mcp-switch: Error: @local/dsh-mcp-switch/locale/._en.json must use a language id as its filename`（与 Linux 机同款报错；试验文件已删除）；改后 `title={en,zh}` 且**无** `error` 字段。
  - Host 路由（运行中 DSH 0.2.2-rc.2，web 端口 63795）：`GET /api/mcp-switch/servers` → 200（gitnexus/superting/rea 三行，tools 与 `probe.tokens` 齐全）；伪造 Host → 403；`Sec-Fetch-Site: cross-site` → 403；POST → 405。
  - 真实开关：`plugin_manager set_plugin include:mcp-gitnexus` 开 → `application: applied`，实时工具 0→13、enabled=true；再关 → `applied`，实时工具回到 0 而探测缓存仍是 13（停用态仍可预览）。**profile 补丁已还原**（备份 `~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261113-before-compat-toggle`；还原后与备份 `sort` 后 diff 为空，仅 DSH 重写了条目顺序）。MCP 状态与开始时一致（gitnexus/rea 停用、superting 启用）。
  - 客户端契约（对安装的 0.2.2-rc.2 源码核对）：`window.__ModuleLoader__.load({id,factory})` 仍是加载约定；`settings.section` 仍是 `{kind:'list',scope:'root'}` 槽位；`plugin-manager/changed`、`connection/reset` 事件名未变；`pluginManager.listPlugins` / `setPluginEnabled` 签名未变（已实跑）。
  - **未验证**：页面视觉（无浏览器控制）——插件管理页标题/描述与设置页「MCP 服务」页需用户刷新后目测。
- **当前状态**：version **0.4.0**（本次与上一条一起发布为 v0.4.0）；运行中的 DSH **0.2.2-rc.2**（本机桌面外壳是 0.2.2-rc.1）。
- **未完成 & 下一步**：
  1. 用户刷新插件管理页确认标题变成「MCP 服务开关」（页面视觉无浏览器控制，未验证）；
  2. 另一台 Linux 机（107.131）上的插件源码仍是旧 locale 结构，需把本仓库这批改动同步过去（重新拷目录**必须**带 `tar --exclude='._*'`，或直接 `git pull`）。
- **坑**：
  1. **DSH 0.2.2 的语言包加载器对目录内容零容忍**：`locale/` 下每个 `*.json` 都会被当语言字典，文件名必须匹配 `/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/`；`._en.json` 这种 AppleDouble 旁注文件会让**整包**元信息读取失败（`link:` 安装同样中招，因为加载器直接 `readdirSync` 真实目录）。
  2. **展示元信息只认 `meta`**：平铺 `title`/`description` 被忽略 → 标题退化成包名；`package.json` 顶层的 `meta` 也不作数（只读语言包 JSON）。
  3. **桌面外壳版本 ≠ DSH CLI 版本**：本机 `runtime.json` 的 `desktopVersion` 是 0.2.2-rc.1，CLI 是 0.2.2-rc.2；老的 compat 脚本读前者 → 假警报。
  4. **`engines.dsh` 是顶层字段**：`dsh.engines` 不参与兼容校验；DSH 比较 peer 时带 `includePrerelease`，所以 `^0.2.0-rc.2` 能放行 `0.2.2-rc.2`。
  5. **superting 独立探测 401**：profile 里内联的 SuperTing token 已失效（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `mcp-superting.headers.Authorization` 用 `!!js` 取 `SUPERTING_MCP_TOKEN`，否则回退到写死的旧 token），探测报 `initialize failed with HTTP 401`；页面里 superting 的「说明」因此显示未知（tools 1221、说明 0）。与本插件无关，需更新 token。
  6. 插件管理器每次列 bundle 报 `llm-deepseek-account: models is no longer configurable`，是本机 profile 的旧配置（模型目录改由账号 `/models` 供给），与本插件无关。

---

## 2026-10-22 v0.4.0：工具预览增加「上下文 token 占用」估算

- **背景/目标**：用户要求预览 MCP 工具时同时预测它在会话里占用的 token（2K/3K/5K/10K/50K 量级），以便决定开不开。
- **改了什么**：
  - **`probe.js`**：按 DSH 自己的计价公式给探测结果计价 —— `toolsTokens = ceil(JSON.stringify(tools)/4)+4`（`dsh-token-meter/estimate` 的固定启发式），`instructionsTokens = ceil(len("### MCP server: <name>\n\n"+instructions)/4)+4`；`tools` 项按 DSH 模型可见形态 `{name: publicToolName, description（完整原文）, parameters: inputSchema}` 构造（`publicToolName` 复刻 mcp-client 命名契约，含 12 位 hash 兜底）。新增：每工具 `tokens`、`tokens{tools,instructions,total}`、`capabilities`（tools/resources/prompts/... 摘要）、`instructions{preview(≤600 字符),chars,tokens}`。
  - **`index.js`**：探测缓存（版本 2）新增 `tokens` / `instructions` / `capabilities` / `instructionsKnown`；运行中服务的实时工具回写时按实际 `ctx.tools.schemas()` 重算 token、同配置时保留说明与能力元数据；**实时回写改用 resolved config 计算指纹**（否则 `!!js` raw config 与探测器 resolved config 的指纹不同，每次 GET 都会覆盖缓存）；缓存命中要求 `instructionsKnown === true`，旧缓存自动重探测。
  - **`client.js`**：每行显示 `上下文占用 ≈X tokens`，展开显示明细（工具 ≈A + 说明 ≈B）、每个工具的单价、能力 chips（resources/prompts/…）、服务说明预览；页面底部显示**已启用服务合计 ≈X tokens**。实时行缺说明计价时会自动补探测一次（`instructionsKnown` 标记）。
  - 测试 +1：`tests/fixtures/mcp-stdio-server.mjs` 与 HTTP fixture 返回 instructions/capabilities；`tests/probe.test.mjs` 断言 token 公式精确值、instructions、capabilities；`tests/host.test.mjs` 断言 probe 响应/缓存/GET 的 tokens 与实时回写公式；`tests/client.test.mjs` 断言 token 徽标/明细/说明/能力，以及"上次探测缓存命中不重连"。
  - 文档/版本：README 新增「Token 占用估算」章节（公式、口径、本机实测值）；AGENTS 版本 0.4.0、36 项测试、验证矩阵加入 token 公式；package.json 0.4.0 + locale 描述同步。
- **验证（原始结论）**：
  - `npm test` → **36/36 pass**；`npm run compat` → exit 0（0.2.1-rc.2）。
  - 运行中 DSH 实测 `GET /servers`（profile 已还原）：
    - `gitnexus`（停用）13 tools，tokens `{tools:5671, instructions:0, total:5671}`（5.7K），capabilities `tools,resources,prompts`；
    - `superting`（启用）14 tools，tokens `{tools:1221, instructions:347, total:1568}`（1.6K），instructions 1344 字符，capabilities `tools`；
    - `rea`（停用）187 tools，tokens `{tools:132851, instructions:213, total:133064}`（**133K**），capabilities `tools,prompts,completions`。
  - 连续两次 GET 数值一致（实时回写与探测缓存不漂移）；缓存文件 128,576 bytes，`grep Authorization|Bearer|SUPERTING_MCP_TOKEN` → 0。
  - 修复过程中实测踩到并验证：live 回写用 raw `!!js` 指纹导致 GET 每次覆盖缓存（instructions 归零/caps 为空），改用 resolved config 指纹后稳定。
- **当前状态**：version **0.4.0**；运行中的 DSH 0.2.1-rc.2；**未提交/未推送/未打 tag**；上一发布 tag 仍是 `v0.3.0`。
- **未完成 & 下一步**：① 用户刷新页面确认 token 徽标/明细/能力/说明的视觉；② 确认后按发版四步发 v0.4.0（commit → push → tag → Release）；③ `rea` 的 133K 是真实量级（187 工具），说明"先预览再决定开关"的价值；若嫌总量大，可考虑在插件里做工具级 allow-list（当前不做，超出边界）。
- **坑**：
  1. **live 与 probe 必须用同一份 resolved config 算指纹**：`entry.options.config` 里的 `!!js` 节点（superting token）和 `entry.fiber.config`/`entry.evaluate` 求值后的值 hash 不同，会导致"配置没变但缓存永远失效/被覆盖"。现在两条路径都走 `resolveServerConfig()`。
  2. **instructions 只有 `initialize` 返回**：实时工具只能算出工具 schema 的 token，不能凭空知道说明；用 `instructionsKnown` 标记，未知时页面自动补一次探测（已有探测缓存则直接用）。
  3. **缓存版本必须跟着数据结构升级**：v1（无 tokens）→ v2；缓存命中条件包含 `instructionsKnown === true`，否则会用缺说明的旧价。
  4. 计价口径：DSH 的 `toolsTokens` 是**全部可见工具**的合计；本页是"单服务工具子集 + 该服务说明"，相加≈全部启用服务合计，实际模型 tokenizer 与 4 字符/token 有偏差。
- **相关备份**：`~/.dsh/profiles/desktop/cordis.patch.yml.bak-20261021-210623`（仍为基线）；本日实验用 `/tmp/cordis-token-check.yml` 等临时副本，最终已 `diff` 还原。

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
