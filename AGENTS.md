# AGENTS.md — dsh-mcp-switch 项目指令（含会话交接）

> 本文件会被 DSH 注入到「以本目录（或其子目录）为工作区」的会话上下文里（与 ops/AGENTS.md 同一机制）。
> 发现规则（DSH 源码 `@deepseek-ai/dsh-agent-instructions`）：从会话 cwd 沿 `AGENTS.md` / `CLAUDE.md`
> 向上找到 git 根目录，链上每一层的同名文件都会被注入，另有全局层 `~/.dsh/AGENTS.md`。
> 目标：**任何新会话读完本文件 + [`docs/HANDOFF.md`](docs/HANDOFF.md)，5 分钟内接手**，不需要翻聊天记录。
> 稳定约定写在这里；版本号、发布情况、待办等会变的状态写在 HANDOFF。

## 0. 30 秒速览

| 项 | 值 |
|---|---|
| 这是什么 | DSH Web UI 的「设置 → MCP 服务」开关页插件：逐个启用/停用 profile 里的 MCP 服务器，热生效 |
| 代码位置 | `~/Documents/workspace/open-source/dsh-mcp-switch`（就是本目录，独立 git 仓库） |
| 远端 | <https://github.com/AbelKeithsun/dsh-mcp-switch>（public · MIT） |
| 安装形态 | DSH profile 的 `link:` 依赖（由 `plugin_manager install_bundle` 写入）；改文件即时生效，**换 JS 模块代需重启 dsh** |
| 技术形态 | 纯 JS、零依赖、零构建；宿主半边是空壳，全部逻辑在浏览器半边 |
| 当前版本 | 见 [`package.json`](package.json)（v0.1.1）；实际状态以 HANDOFF 为准 |

## 1. 会话启动自检（先跑，别猜）

```bash
pwd                     # 必须是本目录
node -v                 # 作者环境 24.x（>=22 可用）
npm test                # 期望 11 项全绿
npm run compat          # 期望 exit 0（比对运行中的 DSH 版本 vs dsh.testedWith）
git log --oneline -3; git status --short
```

再确认插件在**正在运行**的 DSH 里是活的（两条只读查询，不需要批准）：

1. `plugin_manager` → `action: list_plugins` → 找 `include:mcp-switch`，应为 `enabled: true, fiberPhase: active`；
2. `cordis_inspect_query`（client · `Slots.listSubTree` · `root=settings.section`）→ occupants 里应有 `mcp-switch`（order 16）。

任一项对不上：先看 HANDOFF 的「坑」，再动手，不要靠推测。

## 2. 硬约定（违反前先想清楚）

1. **开关只走已有机制**：调用 `pluginManager` Remote（`listPlugins` / `setPluginEnabled`）。不要在 client 里自己改写 profile 文件，也不要为此新增宿主服务——那会重造已存在的实现。
2. **不引入 Harness 客户端包**：`client.js` 用 `window.__ModuleLoader__.load` + 模块表 `require('react')`；不 import `@deepseek-ai/dsh-client-*`（版本一变就炸，且没有类型检查兜底）。
3. **样式只用主题 token**（`--dsw-alias-*`），不写死颜色；可见文案一律走 `locale` 服务，`zh` / `en` 都要补。
4. **改完必须真跑**：单测 + 真实开关一次（关一个再开回来，确认 `application: applied`），**结束后还原**被改动的 MCP 状态。
5. **兼容声明是契约**：DSH 只读 `peerDependencies` 里 `@deepseek-ai/dsh*` 的范围；`dsh.testedWith` 只写真跑过的版本。升级 DSH 后按 `npm run compat` 打印的 5 项清单复验。
6. **全局/破坏性配置改动**（profile 补丁、机器级层、MCP 服务器增删）必须先 `cp` 备份，并在 HANDOFF 里写明回滚命令。

## 3. 目录与职责

| 文件 | 职责 | 改动风险 |
|---|---|---|
| `client.js` | 浏览器半边：`settings.section` 注册「MCP 服务」页、store、开关控件、CSS、zh/en 字典 | 高（唯一有逻辑的文件） |
| `index.js` | 宿主半边：`apply(){}` 空实现 | 低 |
| `cordis.patch.yml` | 插入宿主行 `mcp-switch`（id 即 profile 里的 `include:mcp-switch`） | 中 |
| `package.json` | bundle 清单 + `dsh.client` + **DSH 兼容声明** | 中（兼容字段一错就被 DSH 拦） |
| `scripts/check-compat.mjs` | `npm run compat`：探测运行版本、版本不在实测清单则退出 1 并打印复验清单 | 低 |
| `tests/client.test.mjs` | 客户端行为 6 项（假 `window.__ModuleLoader__` / React / ctx 跑真实 `apply()`） | — |
| `tests/compat.test.mjs` | 兼容声明 5 项（机器无关） | — |
| `locale/{zh,en}.json` | 插件管理页展示文案 | 低 |
| `docs/HANDOFF.md` | **会话交接日志**（倒序追加） | — |

## 4. 常见任务的入口

- **新增一个 MCP 服务器**：不是改本插件。在 profile 补丁 `$DSH_PROFILE_DIR/cordis.patch.yml` 里 insert 一行 `@deepseek-ai/dsh-mcp-client`，页面会自动多出一行（未知行用 patchId 命名）；想要中文名与说明就加进 `client.js` 的 `KNOWN` 表。
- **页面行点不动 / 显示"被覆盖"**：该行声明在机器级层 `$DSH_HOME/cordis.patch.yml`（优先级高于 profile 补丁，而 `setPluginEnabled` 只写 profile 补丁）。把该行 `insert` 段下沉到 profile 补丁。详见 README「为什么有的行被覆盖」。
- **改文案/样式**：`client.js` 末尾的 `zh` / `en` 字典、`CSS` 常量。
- **改完不生效**：确认 profile 的 `link:` 指向本目录（`readlink ~/.dsh/profiles/$DSH_PROFILE/node_modules/@local/dsh-mcp-switch`）；如果刚换过安装路径，需要重启 dsh 载入新模块代。

## 5. 验证矩阵（按改动类型挑）

| 改了什么 | 至少要做 |
|---|---|
| `client.js` | `npm test` + 页面里真实开关一次（关→开→确认 applied） |
| `package.json` 兼容声明 | `npm run compat` + 把插件自身 `set_plugin` off/on 一次（证明声明不会误伤自己） |
| `cordis.patch.yml` | 重装/重载后确认 `include:mcp-switch` 仍 active |
| 文档 | `npm test`（防顺手改坏），无需真机验证 |

## 6. 发版流程（四步，缺一不可）

1. 改 `version`（并同步受影响的文档：README 兼容表、HANDOFF 当前状态）；
2. `npm test` && `npm run compat` 全过；
3. `git add -A && git commit && git push origin main`（GitHub 需 `HTTPS_PROXY=http://127.0.0.1:7897`）；
4. **打 tag + 建 Release**：`gh release create vX.Y.Z --target main --title "…" --notes "…"`；
   自检 tag 与 main 对齐：
   ```bash
   gh api repos/AbelKeithsun/dsh-mcp-switch/git/ref/tags/vX.Y.Z --jq '.object.sha[0:7]'
   gh api repos/AbelKeithsun/dsh-mcp-switch/commits/main --jq '.sha[0:7]'
   ```
   （作者踩过"只发 npm 不打 tag"的坑，此项目同样要求 tag 与 Release 齐全。）

## 7. 会话交接纪律（本项目的核心要求）

**每次收尾**，在 [`docs/HANDOFF.md`](docs/HANDOFF.md) **顶部**追加一条（倒序，最新在上）：

```markdown
## YYYY-MM-DD 一句话标题
- 背景/目标：
- 改了什么：文件 + 行/函数级
- 验证：跑了什么命令、原始结论（不要写"应该没问题"）
- 当前状态：version / 运行中的 DSH / 发布与 tag
- 未完成 & 下一步：
- 坑：下次会踩的
```

规则：

- 只写**可复现的事实**（命令、输出、路径、sha）；推测必须标注"未验证"。
- 状态会变的东西（版本、发布到哪、待办）一律进 HANDOFF，不进本文件。
- 新会话能拿到的只有：**本文件 + HANDOFF + git log**。任何"只存在于聊天里的结论"都等于丢失。

## 8. 边界（不做什么）

- 只做"MCP 服务器开关"。新增服务器、改 transport/token、诊断 MCP 进程本身，属于 profile 配置或对应 MCP 项目，不是本插件职责。
- 不碰 DSH 安装目录（`app.asar`）、不改 profile 的 `package.json`/`cordis.patch.yml`（这些由 `plugin_manager` 拥有；唯一例外见第 4 节「下沉机器级层」，且必须先备份）。
- 不为了"看起来更完整"而加功能：当前形态（一页 + 每行一个 switch）是刻意保持的最小面。
