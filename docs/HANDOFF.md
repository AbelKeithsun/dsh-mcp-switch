# 交接日志（HANDOFF）

> **倒序**：最新在最上面。每次会话收尾**必须**在此追加一条，格式见 [`../AGENTS.md`](../AGENTS.md) 第 7 节。
> 只写可复现的事实；推测标注"未验证"。状态类信息（版本/发布/待办）以本文件为准。

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
